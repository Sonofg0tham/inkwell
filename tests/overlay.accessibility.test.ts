// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SuggestionCard } from '../lib/content/overlay/card';
import { destroyOverlayHost, getOverlayHost } from '../lib/content/overlay/host';
import { UnderlineLayer } from '../lib/content/overlay/underlines';
import type { DocIssue, Rect } from '../lib/content/types';

const ANCHOR: Rect = { left: 20, top: 30, width: 60, height: 18 };

function spellingIssue(overrides: Partial<DocIssue> = {}): DocIssue {
  return {
    id: 'spelling-1',
    type: 'spelling',
    start: 5,
    end: 12,
    original: 'recieve',
    replacement: 'receive',
    explanation: 'This word is misspelled.',
    docStart: 5,
    docEnd: 12,
    chunkHash: 'chunk-1',
    ...overrides,
  };
}

function buttonNamed(container: ParentNode, name: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent === name,
  );
}

function relativeLuminance(cssColour: string): number {
  const hex = cssColour.match(/^#([\da-f]{6})$/i)?.[1];
  const channels = hex
    ? [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map((value) => parseInt(value, 16))
    : cssColour.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) throw new Error(`Unsupported colour: ${cssColour}`);
  const [r, g, b] = channels.map((channel) => {
    const value = channel! / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe('in-page overlay accessibility', () => {
  beforeEach(() => {
    destroyOverlayHost();
    document.body.replaceChildren();
  });

  afterEach(() => {
    destroyOverlayHost();
    vi.restoreAllMocks();
  });

  it('keeps a usable internal reference while hiding the shadow root from page scripts', () => {
    const host = getOverlayHost();

    expect(host.hostEl.shadowRoot).toBeNull();
    expect(host.root.host).toBe(host.hostEl);
    expect(host.root.querySelector('.ink-layer')).not.toBeNull();
  });

  it('renders each underline as a named native button that activates with click', () => {
    const host = getOverlayHost();
    const onPress = vi.fn();
    const layer = new UnderlineLayer(host, {
      onEnter: vi.fn(),
      onLeave: vi.fn(),
      onPress,
    });

    layer.render([{ issueId: 'issue-1', type: 'spelling', rects: [ANCHOR] }]);

    const segment = host.segLayer.querySelector<HTMLButtonElement>('.ink-seg');
    expect(segment).not.toBeNull();
    expect(segment?.tagName).toBe('BUTTON');
    expect(segment?.type).toBe('button');
    expect(segment?.tabIndex).toBe(0);
    expect(segment?.getAttribute('aria-label')).toBe('Spelling suggestion. Activate to review.');

    segment?.click();
    expect(onPress).toHaveBeenCalledWith('issue-1', ANCHOR);
  });

  it('renders model text safely inside a labelled non-modal dialog', () => {
    const host = getOverlayHost();
    const card = new SuggestionCard(host, { onApply: vi.fn(), onDismiss: vi.fn() });
    const trigger = document.createElement('button');
    host.segLayer.appendChild(trigger);
    trigger.focus();

    card.show(
      spellingIssue({
        original: '<img src=x onerror=alert(1)>',
        replacement: '<script>alert(1)</script>',
        explanation: '<b>Use the corrected spelling.</b>',
      }),
      ANCHOR,
    );

    const dialog = host.cardLayer.querySelector<HTMLElement>('.ink-card');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('false');
    const titleId = dialog?.getAttribute('aria-labelledby');
    expect(titleId).toBeTruthy();
    expect(host.root.getElementById(titleId ?? '')?.textContent).toBe('Spelling suggestion');
    expect(dialog?.querySelector('img')).toBeNull();
    expect(dialog?.querySelector('script')).toBeNull();
    expect(dialog?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(dialog?.textContent).toContain('<script>alert(1)</script>');
  });

  it('keeps primary action text at WCAG AA contrast', () => {
    const host = getOverlayHost();
    const card = new SuggestionCard(host, { onApply: vi.fn(), onDismiss: vi.fn() });
    card.show(spellingIssue(), ANCHOR);

    const apply = host.cardLayer.querySelector<HTMLButtonElement>('.ink-card-btn-apply')!;
    const style = getComputedStyle(apply);

    expect(contrastRatio(style.color, style.backgroundColor)).toBeGreaterThanOrEqual(4.5);
  });

  it('uses native button clicks for applying and dismissing suggestions', () => {
    const host = getOverlayHost();
    const issue = spellingIssue();
    const onApply = vi.fn();
    const onDismiss = vi.fn();
    const card = new SuggestionCard(host, { onApply, onDismiss });

    card.show(issue, ANCHOR);
    host.cardLayer.querySelector<HTMLButtonElement>('.ink-card-btn-apply')?.click();
    expect(onApply).toHaveBeenCalledWith(issue);

    card.show(issue, ANCHOR);
    host.cardLayer.querySelector<HTMLButtonElement>('.ink-card-btn-dismiss')?.click();
    expect(onDismiss).toHaveBeenCalledWith(issue);
  });

  it('applies safely when removing focused card content re-enters hide', () => {
    const host = getOverlayHost();
    const issue = spellingIssue();
    const onApply = vi.fn();
    const card = new SuggestionCard(host, { onApply, onDismiss: vi.fn() });
    card.show(issue, ANCHOR);
    const dialog = host.cardLayer.querySelector<HTMLDivElement>('.ink-card')!;
    const nativeRemove = dialog.remove.bind(dialog);
    let depth = 0;
    dialog.remove = () => {
      depth += 1;
      if (depth === 1) {
        card.hide();
        if (!dialog.isConnected) throw new DOMException('Re-entrant removal', 'NotFoundError');
      }
      nativeRemove();
      depth -= 1;
    };

    expect(() => {
      host.cardLayer.querySelector<HTMLButtonElement>('.ink-card-btn-apply')?.click();
    }).not.toThrow();
    expect(onApply).toHaveBeenCalledWith(issue);
  });

  it('offers named native personalisation actions for spelling suggestions', () => {
    const host = getOverlayHost();
    const issue = spellingIssue();
    const onAddToDictionary = vi.fn();
    const onIgnoreAll = vi.fn();
    const card = new SuggestionCard(host, {
      onApply: vi.fn(),
      onDismiss: vi.fn(),
      onAddToDictionary,
      onIgnoreAll,
    });

    card.show(issue, ANCHOR);
    const add = buttonNamed(host.cardLayer, 'Add to dictionary');
    expect(add?.tagName).toBe('BUTTON');
    expect(add?.type).toBe('button');
    add?.click();
    expect(onAddToDictionary).toHaveBeenCalledWith('recieve');

    card.show(issue, ANCHOR);
    const ignoreAll = buttonNamed(host.cardLayer, 'Ignore all');
    expect(ignoreAll?.tagName).toBe('BUTTON');
    expect(ignoreAll?.type).toBe('button');
    ignoreAll?.click();
    expect(onIgnoreAll).toHaveBeenCalledWith('recieve');
  });

  it('does not offer dictionary actions for grammar suggestions', () => {
    const host = getOverlayHost();
    const card = new SuggestionCard(host, {
      onApply: vi.fn(),
      onDismiss: vi.fn(),
      onAddToDictionary: vi.fn(),
      onIgnoreAll: vi.fn(),
    });

    card.show(spellingIssue({ type: 'grammar' }), ANCHOR);

    expect(buttonNamed(host.cardLayer, 'Add to dictionary')).toBeUndefined();
    expect(buttonNamed(host.cardLayer, 'Ignore all')).toBeUndefined();
  });

  it('keeps the card open for internal pointer presses and closes it for page presses', () => {
    const host = getOverlayHost();
    const card = new SuggestionCard(host, { onApply: vi.fn(), onDismiss: vi.fn() });
    card.show(spellingIssue(), ANCHOR);

    const dialog = host.cardLayer.querySelector<HTMLElement>('.ink-card')!;
    dialog.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    expect(host.cardLayer.querySelector('.ink-card')).toBe(dialog);

    window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    expect(host.cardLayer.querySelector('.ink-card')).toBeNull();
  });

  it('does not leak card pointer presses to the host page', () => {
    const host = getOverlayHost();
    const card = new SuggestionCard(host, { onApply: vi.fn(), onDismiss: vi.fn() });
    const pageListener = vi.fn();
    window.addEventListener('pointerdown', pageListener);
    card.show(spellingIssue(), ANCHOR);

    host.cardLayer
      .querySelector<HTMLElement>('.ink-card')
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));

    expect(pageListener).not.toHaveBeenCalled();
    window.removeEventListener('pointerdown', pageListener);
  });

  it('moves keyboard focus into the card and restores the trigger on Escape', () => {
    const host = getOverlayHost();
    const card = new SuggestionCard(host, { onApply: vi.fn(), onDismiss: vi.fn() });
    const trigger = document.createElement('button');
    trigger.className = 'ink-seg';
    trigger.type = 'button';
    host.segLayer.appendChild(trigger);
    trigger.focus();

    card.show(spellingIssue(), ANCHOR);

    const apply = host.cardLayer.querySelector<HTMLButtonElement>('.ink-card-btn-apply');
    expect(host.root.activeElement).toBe(apply);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(host.cardLayer.querySelector('.ink-card')).toBeNull();
    expect(host.root.activeElement).toBe(trigger);
  });

  it('contains Tab navigation within the open keyboard-triggered card', () => {
    const host = getOverlayHost();
    const card = new SuggestionCard(host, {
      onApply: vi.fn(),
      onDismiss: vi.fn(),
      onAddToDictionary: vi.fn(),
      onIgnoreAll: vi.fn(),
    });
    const trigger = document.createElement('button');
    trigger.className = 'ink-seg';
    trigger.type = 'button';
    host.segLayer.appendChild(trigger);
    trigger.focus();
    card.show(spellingIssue(), ANCHOR);

    const apply = host.cardLayer.querySelector<HTMLButtonElement>('.ink-card-btn-apply')!;
    const ignoreAll = buttonNamed(host.cardLayer, 'Ignore all');
    expect(ignoreAll).toBeTruthy();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(host.root.activeElement).toBe(ignoreAll);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(host.root.activeElement).toBe(apply);
  });

  it.each(['Add to dictionary', 'Ignore all'])('%s restores the keyboard trigger after closing', (action) => {
    const host = getOverlayHost();
    const card = new SuggestionCard(host, {
      onApply: vi.fn(),
      onDismiss: vi.fn(),
      onAddToDictionary: vi.fn(),
      onIgnoreAll: vi.fn(),
    });
    const trigger = document.createElement('button');
    trigger.className = 'ink-seg';
    trigger.type = 'button';
    host.segLayer.appendChild(trigger);
    trigger.focus();
    card.show(spellingIssue(), ANCHOR);

    buttonNamed(host.cardLayer, action)?.click();

    expect(host.cardLayer.querySelector('.ink-card')).toBeNull();
    expect(host.root.activeElement).toBe(trigger);
  });

  it('keeps the card inside a narrow iframe viewport', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(180);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('ink-card')) {
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 220,
          bottom: 120,
          width: 220,
          height: 120,
          toJSON: () => ({}),
        };
      }
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      };
    });
    const host = getOverlayHost();
    const card = new SuggestionCard(host, { onApply: vi.fn(), onDismiss: vi.fn() });

    card.show(spellingIssue(), ANCHOR);

    const dialog = host.cardLayer.querySelector<HTMLElement>('.ink-card')!;
    expect(Number.parseFloat(dialog.style.left)).toBeGreaterThanOrEqual(8);
  });
});
