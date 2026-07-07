// Measures where text spans sit inside a <textarea> or <input>. These elements
// expose no text nodes, so we rebuild their content in a hidden mirror div
// with identical text metrics and read the marker spans' client rects.
import { intersectRect, type Rect } from '../types';
import { getOverlayHost } from './host';

const COPIED_STYLES = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'font-stretch',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-transform',
  'text-indent',
  'text-align',
  'direction',
  'tab-size',
  'box-sizing',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'overflow-wrap',
  'word-break',
] as const;

let mirror: HTMLDivElement | null = null;

function getMirror(): HTMLDivElement {
  if (mirror && mirror.isConnected) return mirror;
  mirror = document.createElement('div');
  mirror.className = 'ink-mirror';
  getOverlayHost().measureLayer.appendChild(mirror);
  return mirror;
}

export interface CharRange {
  start: number;
  end: number;
}

/**
 * Returns, for each requested range, the viewport rects of that text inside
 * the control (one rect per wrapped line fragment), clipped to the control's
 * visible content box. All ranges are measured in a single layout pass.
 */
export function measureTextControl(
  el: HTMLTextAreaElement | HTMLInputElement,
  ranges: CharRange[],
): Rect[][] {
  if (ranges.length === 0) return [];
  const view = el.ownerDocument.defaultView ?? window;
  const computed = view.getComputedStyle(el);
  const m = getMirror();

  for (const prop of COPIED_STYLES) {
    m.style.setProperty(prop, computed.getPropertyValue(prop));
  }
  const targetRect = el.getBoundingClientRect();
  if (el instanceof HTMLTextAreaElement) {
    m.style.whiteSpace = 'pre-wrap';
    m.style.overflowWrap = computed.getPropertyValue('overflow-wrap') || 'break-word';
    m.style.width = `${targetRect.width}px`;
  } else {
    m.style.whiteSpace = 'pre';
    m.style.width = 'auto';
  }

  // Build content: alternating text nodes and marker spans, one pass for all
  // ranges. Only createTextNode — the value is page-controlled text.
  const value = el.value;
  const sorted = ranges
    .map((r, originalIndex) => ({ ...r, originalIndex }))
    .sort((a, b) => a.start - b.start);
  const frag = document.createDocumentFragment();
  const marks: Array<{ span: HTMLSpanElement; originalIndex: number }> = [];
  let cursor = 0;
  for (const r of sorted) {
    const start = Math.max(cursor, Math.min(r.start, value.length));
    const end = Math.max(start, Math.min(r.end, value.length));
    if (start > cursor) frag.appendChild(document.createTextNode(value.slice(cursor, start)));
    const span = document.createElement('span');
    span.appendChild(document.createTextNode(value.slice(start, end)));
    frag.appendChild(span);
    marks.push({ span, originalIndex: r.originalIndex });
    cursor = end;
  }
  if (cursor < value.length) frag.appendChild(document.createTextNode(value.slice(cursor)));
  // Trailing-newline height quirk: give the final line something to measure.
  if (value.endsWith('\n')) frag.appendChild(document.createTextNode('​'));
  m.replaceChildren(frag);

  const mirrorRect = m.getBoundingClientRect();

  // Visible content box (inside borders) — rects outside it are clipped away,
  // which makes underlines vanish correctly when the control scrolls internally.
  const borderTop = parseFloat(computed.borderTopWidth) || 0;
  const borderLeft = parseFloat(computed.borderLeftWidth) || 0;
  const borderRight = parseFloat(computed.borderRightWidth) || 0;
  const borderBottom = parseFloat(computed.borderBottomWidth) || 0;
  const contentBox: Rect = {
    left: targetRect.left + borderLeft,
    top: targetRect.top + borderTop,
    width: targetRect.width - borderLeft - borderRight,
    height: targetRect.height - borderTop - borderBottom,
  };

  const results: Rect[][] = ranges.map(() => []);
  for (const { span, originalIndex } of marks) {
    const rects: Rect[] = [];
    for (const r of span.getClientRects()) {
      const mapped: Rect = {
        left: targetRect.left + (r.left - mirrorRect.left) - el.scrollLeft,
        top: targetRect.top + (r.top - mirrorRect.top) - el.scrollTop,
        width: r.width,
        height: r.height,
      };
      const clipped = intersectRect(mapped, contentBox);
      if (clipped) rects.push(clipped);
    }
    results[originalIndex] = rects;
  }
  m.replaceChildren();
  return results;
}
