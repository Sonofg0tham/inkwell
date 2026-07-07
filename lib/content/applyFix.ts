// Applies a suggested fix without corrupting framework-controlled editors.
// Strategy: real selection + execCommand('insertText') so the edit flows
// through the page's own beforeinput/input pipeline (React, ProseMirror,
// Slate, Quill all accept it) and native undo keeps working.
import type { DocIssue, FieldTarget } from './types';
import { buildTextIndex, rangeFromOffsets } from './textIndex';

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
  const range = rangeFromOffsets(index, issue.docStart, issue.docEnd);
  if (!range) return false;

  const doc = el.ownerDocument;
  const selection = doc.getSelection();
  if (!selection) return false;

  el.focus({ preventScroll: true });
  selection.removeAllRanges();
  selection.addRange(range);
  let ok = false;
  try {
    ok = doc.execCommand('insertText', false, issue.replacement);
  } catch {
    ok = false;
  }
  if (!ok) {
    // Plain-text fallback for pages that block execCommand. Exotic editors may
    // resync their model afterwards; the input event gives them the chance.
    range.deleteContents();
    range.insertNode(doc.createTextNode(issue.replacement));
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: issue.replacement }),
    );
  }
  return true;
}

export function applyFix(target: FieldTarget, issue: DocIssue): boolean {
  if (target.kind === 'contenteditable') return applyToContentEditable(target.el, issue);
  return applyToTextControl(target.el, issue);
}
