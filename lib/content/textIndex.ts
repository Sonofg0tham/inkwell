// Extracts plain text from a contenteditable region with a map back to the
// DOM, so issue offsets can become Ranges without ever mutating the page.

export interface TextSegment {
  node: Text;
  /** Offset of this node's first character in the extracted text. */
  start: number;
  length: number;
}

export interface TextIndex {
  text: string;
  segments: TextSegment[];
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
const ATOMIC_TAGS = new Set([
  'IMG',
  'HR',
  'SVG',
  'CANVAS',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'VIDEO',
  'AUDIO',
  'INPUT',
  'TEXTAREA',
  'SELECT',
  'BUTTON',
]);
const BLOCK_DISPLAYS = new Set([
  'block',
  'list-item',
  'table',
  'table-row',
  'table-cell',
  'table-caption',
  'flex',
  'grid',
  'flow-root',
]);

export function buildTextIndex(root: HTMLElement): TextIndex {
  const view = root.ownerDocument.defaultView ?? window;
  let text = '';
  const segments: TextSegment[] = [];

  const ensureNewline = () => {
    if (text.length > 0 && !text.endsWith('\n')) text += '\n';
  };

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const data = (node as Text).data;
      if (data.length > 0) {
        segments.push({ node: node as Text, start: text.length, length: data.length });
        text += data;
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (SKIP_TAGS.has(el.tagName)) return;
    const tagName = el.tagName.toUpperCase();
    if (el.getAttribute('contenteditable') === 'false' || ATOMIC_TAGS.has(tagName)) {
      // Mentions, media, embeds and form controls must be hard text boundaries.
      // Otherwise text on either side is concatenated and a model range can
      // span and delete the atomic node.
      ensureNewline();
      return;
    }
    if (tagName === 'BR') {
      text += '\n';
      return;
    }
    const style = view.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    const isBlock = BLOCK_DISPLAYS.has(style.display);
    if (isBlock) ensureNewline();
    for (let child = el.firstChild; child; child = child.nextSibling) walk(child);
    if (isBlock) ensureNewline();
  };

  for (let child = root.firstChild; child; child = child.nextSibling) walk(child);
  return { text, segments };
}

function locate(
  index: TextIndex,
  offset: number,
  direction: 'forward' | 'backward',
): { node: Text; offset: number } | null {
  const segs = index.segments;
  if (segs.length === 0) return null;
  let lo = 0;
  let hi = segs.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segs[mid]!;
    const end = s.start + s.length;
    if (offset < s.start || (offset === s.start && direction === 'backward')) hi = mid - 1;
    else if (offset > end || (offset === end && direction === 'forward')) lo = mid + 1;
    else {
      found = mid;
      break;
    }
  }
  if (found === -1) {
    // Offset lands in a virtual newline (block boundary) — snap to a real node.
    if (direction === 'forward') {
      const next = segs.find((s) => s.start >= offset);
      if (next) return { node: next.node, offset: 0 };
      const last = segs.at(-1)!;
      return offset === last.start + last.length
        ? { node: last.node, offset: last.length }
        : null;
    }
    let prev: TextSegment | null = null;
    for (const s of segs) {
      if (s.start + s.length <= offset) prev = s;
      else break;
    }
    return prev ? { node: prev.node, offset: prev.length } : null;
  }
  const s = segs[found]!;
  return { node: s.node, offset: offset - s.start };
}

function isContiguousIndexedText(index: TextIndex, start: number, end: number): boolean {
  if (start < 0 || end < start || end > index.text.length) return false;
  if (start === end) return true;

  let coveredUntil = start;
  for (const segment of index.segments) {
    const segmentEnd = segment.start + segment.length;
    if (segmentEnd <= coveredUntil) continue;
    if (segment.start > coveredUntil) return false;
    coveredUntil = segmentEnd;
    if (coveredUntil >= end) return true;
  }
  return false;
}

export function rangeFromOffsets(
  index: TextIndex,
  start: number,
  end: number,
  allowCollapsed = false,
  collapsedAffinity: 'forward' | 'backward' = 'forward',
): Range | null {
  // Virtual newlines represent block and atomic-node boundaries, not DOM text.
  // A Range spanning one could delete an embed even when the model quoted the
  // indexed newline exactly, so only map fully contiguous text segments.
  if (!isContiguousIndexedText(index, start, end)) return null;
  const startLoc = locate(
    index,
    start,
    start === end && allowCollapsed ? collapsedAffinity : 'forward',
  );
  const endLoc = start === end && allowCollapsed ? startLoc : locate(index, end, 'backward');
  if (!startLoc || !endLoc) return null;
  const doc = startLoc.node.ownerDocument;
  const range = doc.createRange();
  try {
    range.setStart(startLoc.node, startLoc.offset);
    range.setEnd(endLoc.node, endLoc.offset);
  } catch {
    return null;
  }
  return range.collapsed && !allowCollapsed ? null : range;
}

/** Document-text offset for a (node, offset) selection position, or null. */
export function offsetFromPoint(index: TextIndex, node: Node, offset: number): number | null {
  for (const s of index.segments) {
    if (s.node === node) return s.start + Math.min(offset, s.length);
  }
  return null;
}
