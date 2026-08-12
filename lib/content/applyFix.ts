// Applies a suggested fix without corrupting framework-controlled editors.
// Strategy: real selection + execCommand('insertText') so the edit flows
// through the page's own beforeinput/input pipeline (React, ProseMirror,
// Slate, Quill all accept it) and native undo keeps working.
import type { DocIssue, FieldTarget } from './types';
import { buildTextIndex, rangeFromOffsets } from './textIndex';

interface MinimalReplacement {
  start: number;
  end: number;
  text: string;
}

/**
 * Keep native contenteditable edits inside the narrowest possible DOM range.
 * Chromium can move a full replacement outside an inline wrapper when the
 * selection starts at that wrapper's first character. Inserting only the
 * changed middle avoids crossing that boundary and preserves formatting.
 */
function minimiseReplacement(issue: DocIssue): MinimalReplacement {
  const { original, replacement } = issue;
  const sharedLimit = Math.min(original.length, replacement.length);
  let prefix = 0;
  while (prefix < sharedLimit && original[prefix] === replacement[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < original.length - prefix &&
    suffix < replacement.length - prefix &&
    original[original.length - 1 - suffix] === replacement[replacement.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return {
    start: issue.docStart + prefix,
    end: issue.docEnd - suffix,
    text: replacement.slice(prefix, replacement.length - suffix),
  };
}

function applyToTextControl(
  el: HTMLTextAreaElement | HTMLInputElement,
  issue: DocIssue,
): boolean {
  const value = el.value;
  // Re-verify before touching anything — stale offsets must never corrupt text.
  if (value.slice(issue.docStart, issue.docEnd) !== issue.original) return false;

  el.focus({ preventScroll: true });
  el.setSelectionRange(issue.docStart, issue.docEnd);
  let ok = false;
  try {
    ok = document.execCommand('insertText', false, issue.replacement);
  } catch {
    ok = false;
  }
  const expected =
    value.slice(0, issue.docStart) + issue.replacement + value.slice(issue.docEnd);
  if (!ok || el.value !== expected) {
    // Fallback: native prototype setter defeats React's value tracker so the
    // dispatched event isn't deduplicated. Caveat: resets the undo stack.
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) return false;
    setter.call(el, expected);
    el.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertReplacementText',
        data: issue.replacement,
      }),
    );
    const caret = issue.docStart + issue.replacement.length;
    try {
      el.setSelectionRange(caret, caret);
    } catch {
      // input types that don't support selection — ignore
    }
  }
  return true;
}

function applyToContentEditable(el: HTMLElement, issue: DocIssue): boolean {
  const index = buildTextIndex(el);
  if (index.text.slice(issue.docStart, issue.docEnd) !== issue.original) return false;
  const edit = minimiseReplacement(issue);
  if (edit.start === edit.end && edit.text === '') return true;
  const collapsedAffinity =
    edit.start === edit.end && edit.start > issue.docStart && edit.start === issue.docEnd
      ? 'backward'
      : 'forward';
  const range = rangeFromOffsets(index, edit.start, edit.end, true, collapsedAffinity);
  if (!range) return false;

  const doc = el.ownerDocument;
  const selection = doc.getSelection();
  if (!selection) return false;

  el.focus({ preventScroll: true });
  selection.removeAllRanges();
  selection.addRange(range);
  let ok = false;
  try {
    ok = doc.execCommand('insertText', false, edit.text);
  } catch {
    ok = false;
  }
  if (!ok) {
    // Plain-text fallback for pages that block execCommand. Exotic editors may
    // resync their model afterwards; the input event gives them the chance.
    range.deleteContents();
    range.insertNode(doc.createTextNode(edit.text));
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: edit.text }),
    );
  }
  return true;
}

export function applyFix(target: FieldTarget, issue: DocIssue): boolean {
  if (target.kind === 'contenteditable') return applyToContentEditable(target.el, issue);
  return applyToTextControl(target.el, issue);
}
