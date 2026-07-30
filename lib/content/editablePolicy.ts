import type { FieldTarget } from './types';

const SENSITIVE_AUTOCOMPLETE = new Set([
  'name',
  'honorific-prefix',
  'given-name',
  'additional-name',
  'family-name',
  'honorific-suffix',
  'nickname',
  'username',
  'current-password',
  'new-password',
  'one-time-code',
  'organization-title',
  'organization',
  'street-address',
  'address-line1',
  'address-line2',
  'address-line3',
  'address-level1',
  'address-level2',
  'address-level3',
  'address-level4',
  'country',
  'country-name',
  'postal-code',
  'email',
  'impp',
  'tel',
  'url',
  'transaction-currency',
  'transaction-amount',
  'bday',
  'bday-day',
  'bday-month',
  'bday-year',
  'sex',
]);

const CODE_EDITOR_CLASSES = new Set([
  'monaco-editor',
  'CodeMirror',
  'cm-editor',
  'cm-content',
  'ace_editor',
  'ace_text-input',
  'prism-code-editor',
]);

const SENSITIVE_HINT =
  /(?:^|[\s_.:-])(?:user(?:name)?(?:[\s_-]*(?:input|field))?|login|account|full[\s_-]*name|first[\s_-]*name|last[\s_-]*name|given[\s_-]*name|family[\s_-]*name|address(?:[\s_-]*line\d*)?|street|post(?:al)?[\s_-]*code|zip(?:[\s_-]*code)?|password|passphrase|secret|token|api[\s_-]*key|private[\s_-]*key|pin|otp|cvv|cvc|ssn|national[\s_-]*insurance)(?:$|[\s_.:-])/i;

function* composedAncestors(element: Element): Generator<Element> {
  let current: Element | null = element;
  while (current) {
    yield current;
    if (current.parentElement) {
      current = current.parentElement;
      continue;
    }
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
}

function hasSensitiveAutocomplete(element: HTMLInputElement | HTMLTextAreaElement): boolean {
  const tokens = (element.autocomplete || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return tokens.some(
    (token) =>
      SENSITIVE_AUTOCOMPLETE.has(token) ||
      token.startsWith('cc-') ||
      token.startsWith('tel-'),
  );
}

function hasSensitiveHint(element: Element): boolean {
  for (const attribute of ['name', 'id', 'aria-label', 'placeholder', 'data-testid']) {
    const value = element.getAttribute(attribute);
    if (value && SENSITIVE_HINT.test(value)) return true;
  }
  return false;
}

function isExcludedByAncestor(element: Element): boolean {
  for (const ancestor of composedAncestors(element)) {
    if (ancestor.hasAttribute('data-inkwell-disable')) return true;
    if (ancestor.getAttribute('spellcheck')?.toLowerCase() === 'false') return true;
    if (ancestor.tagName === 'CODE' || ancestor.tagName === 'PRE') return true;
    if (ancestor.getAttribute('role')?.toLowerCase() === 'code') return true;
    for (const className of ancestor.classList) {
      if (CODE_EDITOR_CLASSES.has(className)) return true;
    }
  }
  return false;
}

/** Whether an event target belongs to Inkwell's in-page overlay shadow tree. */
export function isInkwellOverlayTarget(raw: EventTarget | null): boolean {
  if (!(raw instanceof Node)) return false;
  let current: Node | null = raw;
  while (current) {
    if (current instanceof Element && current.localName === 'inkwell-overlay') return true;
    if (current instanceof ShadowRoot) {
      current = current.host;
      continue;
    }
    if (current.parentNode) {
      current = current.parentNode;
      continue;
    }
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root : null;
  }
  return false;
}

/** Resolve a focused node to a field that is safe and useful to proofread. */
export function resolveEditable(raw: EventTarget | null): FieldTarget | null {
  if (!(raw instanceof Element)) return null;
  if (isExcludedByAncestor(raw) || hasSensitiveHint(raw)) return null;

  if (raw instanceof HTMLTextAreaElement) {
    if (raw.readOnly || raw.disabled || hasSensitiveAutocomplete(raw)) return null;
    return { kind: 'textarea', el: raw };
  }

  if (raw instanceof HTMLInputElement) {
    // Only plain text-ish inputs, never password, email, number, or similar.
    if (raw.type !== 'text' && raw.type !== 'search') return null;
    if (raw.readOnly || raw.disabled || hasSensitiveAutocomplete(raw)) return null;
    return { kind: 'input', el: raw };
  }

  if (raw instanceof HTMLElement && raw.isContentEditable) {
    // Climb to the editing host (the outermost editable element).
    let host: HTMLElement = raw;
    while (host.parentElement?.isContentEditable) host = host.parentElement;
    if (isExcludedByAncestor(host) || hasSensitiveHint(host)) return null;
    return { kind: 'contenteditable', el: host };
  }

  return null;
}
