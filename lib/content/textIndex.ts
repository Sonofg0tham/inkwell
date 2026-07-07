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
    if (el.getAttribute('contenteditable') === 'false') return;
    if (el.tagName === 'BR') {
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
    if (offset < s.start) hi = mid - 1;
    else if (offset > s.start + s.length) lo = mid + 1;
    else {
      found = mid;
      break;
    }
  }
  if (found === -1) {
    // Offset lands in a virtual newline (block boundary) — snap to a real node.
    if (direction === 'forward') {
      const next = segs.find((s) => s.start >= offset);
      return next ? { node: next.node, offset: 0 } : null;
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

export function rangeFromOffsets(index: TextIndex, start: number, end: number): Range | null {
  const startLoc = locate(index, start, 'forward');
  const endLoc = locate(index, end, 'backward');
  if (!startLoc || !endLoc) return null;
  const doc = startLoc.node.ownerDocument;
  const range = doc.createRange();
  try {
    range.setStart(startLoc.node, startLoc.offset);
    range.setEnd(endLoc.node, endLoc.offset);
  } catch {
    return null;
  }
  return range.collapsed ? null : range;
}

/** Document-text offset for a (node, offset) selection position, or null. */
export function offsetFromPoint(index: TextIndex, node: Node, offset: number): number | null {
  for (const s of index.segments) {
    if (s.node === node) return s.start + Math.min(offset, s.length);
  }
  return null;
}
