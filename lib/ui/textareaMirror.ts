// Measures where character ranges sit inside a <textarea> by rebuilding its
// content in a hidden mirror div with identical text metrics. Standalone
// version for extension pages (the content-script variant lives in
// lib/content/overlay/mirror.ts and is coupled to the shadow-DOM host).

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

export interface CharRange {
  start: number;
  end: number;
}

export interface FragmentRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

let mirror: HTMLDivElement | null = null;

function getMirror(parent: HTMLElement): HTMLDivElement {
  if (mirror && mirror.isConnected && mirror.parentElement === parent) return mirror;
  mirror?.remove();
  mirror = document.createElement('div');
  mirror.setAttribute('aria-hidden', 'true');
  mirror.style.position = 'absolute';
  mirror.style.top = '0';
  mirror.style.left = '0';
  mirror.style.visibility = 'hidden';
  mirror.style.pointerEvents = 'none';
  parent.appendChild(mirror);
  return mirror;
}

/**
 * Returns, for each range, the line-fragment rects of that text relative to
 * the textarea's border box (already adjusted for internal scroll). Fragments
 * scrolled outside the visible content box are dropped. Returns empty arrays
 * per range in environments without real layout (unit tests).
 */
export function measureTextareaRanges(
  el: HTMLTextAreaElement,
  ranges: CharRange[],
): FragmentRect[][] {
  const results: FragmentRect[][] = ranges.map(() => []);
  if (ranges.length === 0) return results;
  const parent = el.parentElement;
  if (!parent) return results;

  const computed = getComputedStyle(el);
  const m = getMirror(parent);
  for (const prop of COPIED_STYLES) {
    m.style.setProperty(prop, computed.getPropertyValue(prop));
  }
  m.style.whiteSpace = 'pre-wrap';
  m.style.width = `${el.clientWidth}px`;

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
  if (value.endsWith('\n')) frag.appendChild(document.createTextNode('​'));
  m.replaceChildren(frag);

  const mirrorRect = m.getBoundingClientRect();
  const visibleHeight = el.clientHeight;
  const visibleWidth = el.clientWidth;

  for (const { span, originalIndex } of marks) {
    if (typeof span.getClientRects !== 'function') continue; // no layout engine
    const rects: FragmentRect[] = [];
    for (const r of span.getClientRects()) {
      if (r.width === 0 && r.height === 0) continue; // no layout engine
      const mapped: FragmentRect = {
        left: r.left - mirrorRect.left - el.scrollLeft,
        top: r.top - mirrorRect.top - el.scrollTop,
        width: r.width,
        height: r.height,
      };
      // Clip to the visible content box so underlines vanish when scrolled away.
      if (mapped.top + mapped.height < 0 || mapped.top > visibleHeight) continue;
      if (mapped.left + mapped.width < 0 || mapped.left > visibleWidth) continue;
      rects.push(mapped);
    }
    results[originalIndex] = rects;
  }
  m.replaceChildren();
  return results;
}
