// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../lib/settings/schema';
import { FieldController, type FieldEnv } from '../lib/content/fieldController';

import { startWatcher } from '../lib/content/editableWatcher';

type WatcherHandle = {
  stop(): void;
  settingsChanged(): void;
};

const env = {
  getSettings: () => DEFAULT_SETTINGS,
  port: {},
  reportCount: vi.fn(),
} as unknown as FieldEnv;

let handle: WatcherHandle | (() => void) | null = null;

function dispatchFocus(
  type: 'focusin' | 'focusout',
  dispatchTarget: Element,
  origin: Element,
  relatedTarget: EventTarget | null = null,
): void {
  const event = new FocusEvent(type, {
    bubbles: true,
    composed: true,
    relatedTarget,
  });
  const path: EventTarget[] = [origin];
  const originRoot = origin.getRootNode();
  if (originRoot instanceof ShadowRoot) path.push(originRoot);
  if (dispatchTarget !== origin) path.push(dispatchTarget);
  let parent: Node | null = dispatchTarget.parentNode;
  while (parent) {
    if (!path.includes(parent)) path.push(parent);
    parent = parent.parentNode;
  }
  path.push(window);
  Object.defineProperty(event, 'composedPath', {
    configurable: true,
    value: () => path,
  });
  dispatchTarget.dispatchEvent(event);
}

function start(): WatcherHandle | (() => void) {
  handle = startWatcher(env);
  return handle;
}

function stop(): void {
  if (typeof handle === 'function') handle();
  else handle?.stop();
  handle = null;
}

beforeEach(() => {
  document.body.replaceChildren();
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver = class {
    readonly root = null;
    readonly rootMargin = '0px';
    readonly thresholds = [0];
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] { return []; }
  } as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  stop();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('editable privacy policy', () => {
  it.each([
    'section-checkout shipping cc-number',
    'section-login username webauthn',
    'shipping address-line1',
    'billing postal-code',
    'name',
    'tel',
  ])('ignores sensitive autocomplete tokens anywhere in %s', (autocomplete) => {
    const activate = vi.spyOn(FieldController.prototype, 'activate');
    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('autocomplete', autocomplete);
    document.body.append(input);
    start();

    dispatchFocus('focusin', input, input);

    expect(activate).not.toHaveBeenCalled();
  });

  it.each([
    ['name', 'username', ''],
    ['name', 'userNameInput', ''],
    ['id', 'shipping-address', ''],
    ['id', 'addressLine1', ''],
    ['aria-label', 'Full name', 'textarea'],
    ['placeholder', 'Home postcode', ''],
  ])('ignores a field identified as sensitive by %s', (attribute, value, tag) => {
    const activate = vi.spyOn(FieldController.prototype, 'activate');
    const field = tag === 'textarea'
      ? document.createElement('textarea')
      : document.createElement('input');
    field.setAttribute(attribute, value);
    document.body.append(field);
    start();

    dispatchFocus('focusin', field, field);

    expect(activate).not.toHaveBeenCalled();
  });

  it('respects an explicit spellcheck=false inherited from an ancestor', () => {
    const activate = vi.spyOn(FieldController.prototype, 'activate');
    const wrapper = document.createElement('div');
    wrapper.setAttribute('spellcheck', 'false');
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    wrapper.append(editor);
    document.body.append(wrapper);
    start();

    dispatchFocus('focusin', editor, editor);

    expect(activate).not.toHaveBeenCalled();
  });

  it('honours a nearer spellcheck=true override on the editor', () => {
    const activate = vi.spyOn(FieldController.prototype, 'activate');
    const wrapper = document.createElement('div');
    wrapper.setAttribute('spellcheck', 'false');
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.setAttribute('spellcheck', 'true');
    wrapper.append(editor);
    document.body.append(wrapper);
    start();

    dispatchFocus('focusin', editor, editor);

    expect(activate).toHaveBeenCalledOnce();
  });

  it.each([
    ['label', 'API key'],
    ['aria-labelledby', 'Username'],
  ])('ignores a field identified as sensitive by %s text', (source, labelText) => {
    const activate = vi.spyOn(FieldController.prototype, 'activate');
    const field = document.createElement('textarea');
    field.id = 'sensitive-field';
    if (source === 'label') {
      const label = document.createElement('label');
      label.htmlFor = field.id;
      label.textContent = labelText;
      document.body.append(label, field);
    } else {
      const label = document.createElement('span');
      label.id = 'sensitive-label';
      label.textContent = labelText;
      field.setAttribute('aria-labelledby', label.id);
      document.body.append(label, field);
    }
    start();

    dispatchFocus('focusin', field, field);

    expect(activate).not.toHaveBeenCalled();
  });

  it.each(['monaco-editor', 'cm-editor', 'CodeMirror', 'ace_editor'])(
    'ignores editable controls inside the %s code editor',
    (className) => {
      const activate = vi.spyOn(FieldController.prototype, 'activate');
      const wrapper = document.createElement('div');
      wrapper.className = className;
      const editor = document.createElement('textarea');
      wrapper.append(editor);
      document.body.append(wrapper);
      start();

      dispatchFocus('focusin', editor, editor);

      expect(activate).not.toHaveBeenCalled();
    },
  );

  it('continues to attach to an ordinary writing field', () => {
    const activate = vi.spyOn(FieldController.prototype, 'activate');
    const textarea = document.createElement('textarea');
    textarea.setAttribute('aria-label', 'Write your reply');
    document.body.append(textarea);
    start();

    dispatchFocus('focusin', textarea, textarea);

    expect(activate).toHaveBeenCalledOnce();
  });
});

describe('focus lifecycle', () => {
  it('deactivates a shadow-root field when its composed focus origin blurs', () => {
    const deactivate = vi.spyOn(FieldController.prototype, 'deactivate');
    const shadowHost = document.createElement('section');
    const shadow = shadowHost.attachShadow({ mode: 'open' });
    const textarea = document.createElement('textarea');
    shadow.append(textarea);
    document.body.append(shadowHost);
    start();
    dispatchFocus('focusin', shadowHost, textarea);

    dispatchFocus('focusout', shadowHost, textarea, document.body);

    expect(deactivate).toHaveBeenCalledOnce();
  });

  it('still deactivates if the active field becomes sensitive before blur', () => {
    const deactivate = vi.spyOn(FieldController.prototype, 'deactivate');
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    start();
    dispatchFocus('focusin', textarea, textarea);
    textarea.setAttribute('spellcheck', 'false');

    dispatchFocus('focusout', textarea, textarea, document.body);

    expect(deactivate).toHaveBeenCalledOnce();
  });

  it('deactivates before input when an SPA turns the focused field sensitive', () => {
    const deactivate = vi.spyOn(FieldController.prototype, 'deactivate');
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    start();
    dispatchFocus('focusin', textarea, textarea);
    textarea.setAttribute('autocomplete', 'username');

    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));

    expect(deactivate).toHaveBeenCalledOnce();
  });

  it('keeps the field active while focus is inside Inkwell, then deactivates on exit', () => {
    const deactivate = vi.spyOn(FieldController.prototype, 'deactivate');
    const textarea = document.createElement('textarea');
    const overlayHost = document.createElement('inkwell-overlay');
    const overlay = overlayHost.attachShadow({ mode: 'open' });
    const applyButton = document.createElement('button');
    overlay.append(applyButton);
    const outsideButton = document.createElement('button');
    document.body.append(textarea, overlayHost, outsideButton);
    start();
    dispatchFocus('focusin', textarea, textarea);

    dispatchFocus('focusout', textarea, textarea, overlayHost);
    expect(deactivate).not.toHaveBeenCalled();

    dispatchFocus('focusout', overlayHost, applyButton, outsideButton);
    expect(deactivate).toHaveBeenCalledOnce();
  });
});

describe('watcher settings handle', () => {
  it('forwards settings changes to the active field controller', () => {
    const settingsChanged = vi.spyOn(FieldController.prototype, 'settingsChanged');
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    const watcher = start() as WatcherHandle;
    dispatchFocus('focusin', textarea, textarea);

    expect(typeof watcher.settingsChanged).toBe('function');
    watcher.settingsChanged();

    expect(settingsChanged).toHaveBeenCalledOnce();
  });
});
