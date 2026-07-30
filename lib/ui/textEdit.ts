// Programmatic text edits that keep the browser's own undo stack intact.
//
// Assigning to `el.value` wipes the native undo history, so Ctrl+Z stops
// working right after Inkwell fixes something — which is precisely when a
// writer wants it. execCommand('insertText') routes the edit through the
// browser's editing pipeline instead, so undo, redo and input events all
// behave as if the user typed it. It is deprecated but still the only API in
// Chrome that preserves undo; the native-setter path below is the fallback.

export interface Snapshot {
  text: string;
  caret: number;
}

type TextControl = HTMLTextAreaElement | HTMLInputElement;

/**
 * Replaces [start, end) with `text`. Returns true if the value ended up as
 * expected, by whichever route. Never throws.
 */
export function replaceRange(
  el: TextControl,
  start: number,
  end: number,
  text: string,
): boolean {
  const before = el.value;
  if (start < 0 || end > before.length || end < start) return false;
  const expected = before.slice(0, start) + text + before.slice(end);
  if (expected === before) return true;

  try {
    el.focus({ preventScroll: true });
    el.setSelectionRange(start, end);
  } catch {
    // Some input types don't support selection — fall through to the setter.
  }

  try {
    if (typeof document.execCommand === 'function') {
      document.execCommand('insertText', false, text);
    }
  } catch {
    // Blocked by the page or unimplemented — fall through.
  }

  if (el.value === expected) return true;

  // Fallback: the prototype setter defeats React's value tracker so the
  // dispatched input event isn't deduplicated. Costs the native undo stack,
  // which is why Inkwell keeps its own snapshots as well.
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, expected);
  else el.value = expected;

  el.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: text }),
  );
  const caret = start + text.length;
  try {
    el.setSelectionRange(caret, caret);
  } catch {
    // not selectable — ignore
  }
  return el.value === expected;
}

export function snapshot(el: TextControl): Snapshot {
  return { text: el.value, caret: el.selectionStart ?? el.value.length };
}

export function restore(el: TextControl, snap: Snapshot): boolean {
  const ok = replaceRange(el, 0, el.value.length, snap.text);
  try {
    el.setSelectionRange(snap.caret, snap.caret);
  } catch {
    // not selectable — ignore
  }
  return ok;
}

export interface Edit {
  start: number;
  end: number;
  /** Expected current text of the span — the edit is skipped if it differs. */
  original: string;
  replacement: string;
}

/**
 * Applies many edits in one pass. Works back-to-front so earlier offsets stay
 * valid, and verifies each span before touching it so a stale suggestion can
 * never corrupt unrelated text. Returns how many were applied.
 */
export function applyEdits(el: TextControl, edits: Edit[]): number {
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let applied = 0;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of ordered) {
    if (edit.end > lastStart) continue; // overlaps one we just applied
    if (el.value.slice(edit.start, edit.end) !== edit.original) continue;
    if (replaceRange(el, edit.start, edit.end, edit.replacement)) {
      applied++;
      lastStart = edit.start;
    }
  }
  return applied;
}
