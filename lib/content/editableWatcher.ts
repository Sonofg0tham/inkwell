// Focus-driven discovery of editable surfaces. The content script stays inert
// until the user actually focuses something checkable.
import { FieldController, type FieldEnv } from './fieldController';
import { destroyOverlayHost } from './overlay/host';
import type { FieldTarget } from './types';

const SKIP_AUTOCOMPLETE = /^(cc-|one-time-code)/;

function resolveEditable(raw: EventTarget | null): FieldTarget | null {
  if (!(raw instanceof Element)) return null;
  if (raw.closest('[data-inkwell-disable]')) return null;

  if (raw instanceof HTMLTextAreaElement) {
    if (raw.readOnly || raw.disabled) return null;
    if (SKIP_AUTOCOMPLETE.test(raw.autocomplete ?? '')) return null;
    return { kind: 'textarea', el: raw };
  }
  if (raw instanceof HTMLInputElement) {
    // Only plain text-ish inputs — never password, email, number, etc.
    if (raw.type !== 'text' && raw.type !== 'search') return null;
    if (raw.readOnly || raw.disabled) return null;
    if (SKIP_AUTOCOMPLETE.test(raw.autocomplete ?? '')) return null;
    return { kind: 'input', el: raw };
  }
  if (raw instanceof HTMLElement && raw.isContentEditable) {
    // Climb to the editing host (the outermost editable element).
    let host: HTMLElement = raw;
    while (host.parentElement?.isContentEditable) host = host.parentElement;
    if (host.closest('[data-inkwell-disable]')) return null;
    return { kind: 'contenteditable', el: host };
  }
  return null;
}

export function startWatcher(env: FieldEnv): () => void {
  const controllers = new WeakMap<Element, FieldController>();
  let activeController: FieldController | null = null;
  let activeElement: Element | null = null;

  const attach = (rawTarget: EventTarget | null): void => {
    const target = resolveEditable(rawTarget);
    if (!target || activeElement === target.el) return;
    activeController?.deactivate();
    let controller = controllers.get(target.el);
    if (!controller) {
      controller = new FieldController(target, env);
      controllers.set(target.el, controller);
    }
    activeController = controller;
    activeElement = target.el;
    controller.activate();
  };

  const onFocusIn = (e: FocusEvent): void => attach(e.target);

  const onFocusOut = (e: FocusEvent): void => {
    if (e.target !== activeElement) return;
    activeController?.deactivate();
    activeController = null;
    activeElement = null;
  };

  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  // A field may already be focused when the watcher starts.
  if (document.activeElement) attach(document.activeElement);

  return () => {
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('focusout', onFocusOut, true);
    activeController?.deactivate();
    activeController = null;
    activeElement = null;
    destroyOverlayHost();
  };
}
