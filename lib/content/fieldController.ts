// Per-field orchestration: debounced checking, chunk diffing, underline
// rendering, and the apply/dismiss lifecycle.
import { chunkText, type Chunk } from '../checker/chunker';
import { fnvHash } from '../checker/hash';
import type { IssueDto, PortResponse } from '../messaging/protocol';
import type { Settings } from '../settings/schema';
import { applyFix } from './applyFix';
import { getOverlayHost } from './overlay/host';
import { measureTextControl } from './overlay/mirror';
import { SuggestionCard } from './overlay/card';
import { UnderlineLayer, type SegmentSpec } from './overlay/underlines';
import type { PortClient } from './portClient';
import { buildTextIndex, offsetFromPoint, rangeFromOffsets, type TextIndex } from './textIndex';
import { intersectRect, type DocIssue, type FieldTarget, type Rect } from './types';

export interface FieldEnv {
  getSettings(): Settings;
  port: PortClient;
  reportCount(count: number): void;
}

const DEBOUNCE_MS = 800;
const LARGE_DOC_CHARS = 20_000;
const LARGE_DOC_WINDOW = 2_500;
const HOVER_SHOW_MS = 150;
const HOVER_HIDE_MS = 300;
const MAX_HASH_ENTRIES = 200;
const SCROLLING_OVERFLOWS = new Set(['auto', 'scroll', 'hidden', 'overlay', 'clip']);

let requestCounter = 0;

export class FieldController {
  private issuesByHash = new Map<string, IssueDto[]>();
  private dismissed = new Set<string>();
  private chunks: Chunk[] = [];
  private pending = new Map<string, string>(); // requestId -> chunkHash
  private currentIssues: DocIssue[] = [];
  private textIndexCache: TextIndex | null = null;
  private lastTextLength = 0;
  private lastReportedCount = -1;

  private active = false;
  private composing = false;
  private visible = true;
  private rafId: number | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private hoverShowTimer: ReturnType<typeof setTimeout> | undefined;
  private hoverHideTimer: ReturnType<typeof setTimeout> | undefined;
  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;

  private underlines: UnderlineLayer;
  private card: SuggestionCard;

  constructor(
    private target: FieldTarget,
    private env: FieldEnv,
  ) {
    const host = getOverlayHost();
    this.underlines = new UnderlineLayer(host, {
      onEnter: (id, anchor) => this.onSegmentEnter(id, anchor),
      onLeave: () => this.onSegmentLeave(),
      onPress: (id, anchor) => this.showCard(id, anchor),
    });
    this.card = new SuggestionCard(host, {
      onApply: (issue) => this.apply(issue),
      onDismiss: (issue) => this.dismiss(issue),
    });
  }

  private onInput = (): void => {
    if (this.composing) return;
    this.card.hide();
    this.rechunk();
    this.scheduleRender();
    this.scheduleCheck();
  };

  private onCompositionStart = (): void => {
    this.composing = true;
    this.underlines.clear();
    this.card.hide();
  };

  private onCompositionEnd = (): void => {
    this.composing = false;
    this.onInput();
  };

  private onScrollOrResize = (): void => {
    this.card.hide();
    this.scheduleRender();
  };

  activate(): void {
    if (this.active) return;
    this.active = true;
    const el = this.target.el;
    el.addEventListener('input', this.onInput);
    el.addEventListener('compositionstart', this.onCompositionStart);
    el.addEventListener('compositionend', this.onCompositionEnd);
    // Capture phase catches every scrolling ancestor, including internal scroll.
    document.addEventListener('scroll', this.onScrollOrResize, { capture: true, passive: true });
    window.addEventListener('resize', this.onScrollOrResize);
    this.resizeObserver = new ResizeObserver(() => this.scheduleRender());
    this.resizeObserver.observe(el);
    this.intersectionObserver = new IntersectionObserver((entries) => {
      this.visible = entries[0]?.isIntersecting ?? true;
      this.scheduleRender();
    });
    this.intersectionObserver.observe(el);
    this.rechunk();
    this.scheduleRender();
    this.scheduleCheck();
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    const el = this.target.el;
    el.removeEventListener('input', this.onInput);
    el.removeEventListener('compositionstart', this.onCompositionStart);
    el.removeEventListener('compositionend', this.onCompositionEnd);
    document.removeEventListener('scroll', this.onScrollOrResize, true);
    window.removeEventListener('resize', this.onScrollOrResize);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;
    clearTimeout(this.debounceTimer);
    clearTimeout(this.hoverShowTimer);
    clearTimeout(this.hoverHideTimer);
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.pending.size > 0) {
      this.env.port.cancel([...this.pending.keys()]);
      this.pending.clear();
    }
    this.underlines.clear();
    this.card.hide();
  }

  private getText(): string {
    if (this.target.kind === 'contenteditable') {
      this.textIndexCache = buildTextIndex(this.target.el);
      return this.textIndexCache.text;
    }
    return this.target.el.value;
  }

  private rechunk(): void {
    const settings = this.env.getSettings();
    const text = this.getText();
    this.lastTextLength = text.length;
    this.chunks = chunkText(text, settings.dialect);
    const current = new Set(this.chunks.map((c) => c.hash));

    // Bound the per-field result map; stale-but-bounded entries are kept so
    // undo restores underlines instantly.
    if (this.issuesByHash.size > MAX_HASH_ENTRIES) {
      for (const key of [...this.issuesByHash.keys()]) {
        if (this.issuesByHash.size <= MAX_HASH_ENTRIES) break;
        if (!current.has(key)) this.issuesByHash.delete(key);
      }
    }

    // Cancel in-flight checks whose chunk no longer exists.
    const stale: string[] = [];
    for (const [requestId, hash] of this.pending) {
      if (!current.has(hash)) stale.push(requestId);
    }
    if (stale.length > 0) {
      for (const id of stale) this.pending.delete(id);
      this.env.port.cancel(stale);
    }
  }

  private scheduleCheck(): void {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.requestChecks(), DEBOUNCE_MS);
  }

  private caretOffset(): number {
    if (this.target.kind !== 'contenteditable') {
      return this.target.el.selectionStart ?? 0;
    }
    const sel = this.target.el.ownerDocument.getSelection();
    if (!sel?.anchorNode || !this.textIndexCache) return 0;
    return offsetFromPoint(this.textIndexCache, sel.anchorNode, sel.anchorOffset) ?? 0;
  }

  private requestChecks(): void {
    if (!this.active) return;
    let eligible = this.chunks;
    if (this.lastTextLength > LARGE_DOC_CHARS) {
      const caret = this.caretOffset();
      eligible = this.chunks.filter(
        (c) =>
          c.docOffset <= caret + LARGE_DOC_WINDOW &&
          c.docOffset + c.text.length >= caret - LARGE_DOC_WINDOW,
      );
    }
    const pendingHashes = new Set(this.pending.values());
    for (const chunk of eligible) {
      if (this.issuesByHash.has(chunk.hash) || pendingHashes.has(chunk.hash)) continue;
      const requestId = `ink-${++requestCounter}-${chunk.hash.slice(0, 6)}`;
      this.pending.set(requestId, chunk.hash);
      pendingHashes.add(chunk.hash);
      this.env.port.check(requestId, chunk.hash, chunk.text, (resp) =>
        this.onCheckResponse(requestId, resp),
      );
    }
  }

  private onCheckResponse(requestId: string, resp: PortResponse): void {
    this.pending.delete(requestId);
    if (resp.t === 'error') {
      console.debug('[Inkwell] check failed:', resp.code, resp.hint);
      return;
    }
    this.issuesByHash.set(resp.chunkHash, resp.issues);
    if (this.active && this.chunks.some((c) => c.hash === resp.chunkHash)) {
      this.scheduleRender();
    }
  }

  private scheduleRender(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.render();
    });
  }

  private render(): void {
    if (!this.active || this.composing || !this.visible) {
      this.underlines.clear();
      return;
    }

    const docIssues: DocIssue[] = [];
    for (const chunk of this.chunks) {
      const issues = this.issuesByHash.get(chunk.hash);
      if (!issues) continue;
      for (const issue of issues) {
        if (this.dismissed.has(issue.id)) continue;
        docIssues.push({
          ...issue,
          docStart: chunk.docOffset + issue.start,
          docEnd: chunk.docOffset + issue.end,
          chunkHash: chunk.hash,
        });
      }
    }
    this.currentIssues = docIssues;

    const specs: SegmentSpec[] = [];
    if (this.target.kind === 'contenteditable') {
      // Rebuild — frameworks can re-render the DOM without an input event.
      const index = buildTextIndex(this.target.el);
      const clip = this.clipRectFor(this.target.el);
      for (const issue of docIssues) {
        if (index.text.slice(issue.docStart, issue.docEnd) !== issue.original) continue;
        const range = rangeFromOffsets(index, issue.docStart, issue.docEnd);
        if (!range) continue;
        const rects: Rect[] = [];
        for (const r of range.getClientRects()) {
          const mapped: Rect = { left: r.left, top: r.top, width: r.width, height: r.height };
          const clipped = clip ? intersectRect(mapped, clip) : mapped;
          if (clipped) rects.push(clipped);
        }
        if (rects.length > 0) specs.push({ issueId: issue.id, type: issue.type, rects });
      }
    } else {
      const el = this.target.el;
      const value = el.value;
      const valid = docIssues.filter((i) => value.slice(i.docStart, i.docEnd) === i.original);
      const rectsPerIssue = measureTextControl(
        el,
        valid.map((i) => ({ start: i.docStart, end: i.docEnd })),
      );
      valid.forEach((issue, k) => {
        const rects = rectsPerIssue[k] ?? [];
        if (rects.length > 0) specs.push({ issueId: issue.id, type: issue.type, rects });
      });
    }

    const viewport: Rect = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const visibleSpecs: SegmentSpec[] = [];
    for (const spec of specs) {
      const rects = spec.rects
        .map((r) => intersectRect(r, viewport))
        .filter((r): r is Rect => r !== null);
      if (rects.length > 0) visibleSpecs.push({ ...spec, rects });
    }
    this.underlines.render(visibleSpecs);
    this.report(this.currentIssues.length);
  }

  /** Intersection of every scrolling ancestor's box — underlines must not leak
   *  outside a scrolled container. */
  private clipRectFor(el: HTMLElement): Rect | null {
    const view = el.ownerDocument.defaultView ?? window;
    let clip: Rect | null = null;
    let node: HTMLElement | null = el;
    while (node && node !== el.ownerDocument.body && node !== el.ownerDocument.documentElement) {
      const style = view.getComputedStyle(node);
      if (SCROLLING_OVERFLOWS.has(style.overflowY) || SCROLLING_OVERFLOWS.has(style.overflowX)) {
        const r = node.getBoundingClientRect();
        const rect: Rect = { left: r.left, top: r.top, width: r.width, height: r.height };
        clip = clip ? (intersectRect(clip, rect) ?? { left: 0, top: 0, width: 0, height: 0 }) : rect;
      }
      node = node.parentElement;
    }
    return clip;
  }

  private onSegmentEnter(issueId: string, anchor: Rect): void {
    clearTimeout(this.hoverHideTimer);
    clearTimeout(this.hoverShowTimer);
    this.hoverShowTimer = setTimeout(() => this.showCard(issueId, anchor), HOVER_SHOW_MS);
  }

  private onSegmentLeave(): void {
    clearTimeout(this.hoverShowTimer);
    this.scheduleCardHide();
  }

  private scheduleCardHide(): void {
    clearTimeout(this.hoverHideTimer);
    this.hoverHideTimer = setTimeout(() => {
      if (this.card.isPointerInside) this.scheduleCardHide();
      else this.card.hide();
    }, HOVER_HIDE_MS);
  }

  private showCard(issueId: string, anchor: Rect): void {
    clearTimeout(this.hoverShowTimer);
    clearTimeout(this.hoverHideTimer);
    const issue = this.currentIssues.find((i) => i.id === issueId);
    if (issue) this.card.show(issue, anchor);
  }

  private apply(issue: DocIssue): void {
    const ok = applyFix(this.target, issue);
    if (!ok) {
      // Stale offsets — drop the underline rather than risk corrupting text.
      const list = this.issuesByHash.get(issue.chunkHash);
      if (list) {
        this.issuesByHash.set(
          issue.chunkHash,
          list.filter((i) => i.id !== issue.id),
        );
      }
      this.scheduleRender();
      return;
    }
    // The input event from applyFix already re-chunked. Warm the field cache
    // for the post-fix chunk so the paragraph's other underlines survive
    // without another round trip to the model.
    const list = this.issuesByHash.get(issue.chunkHash);
    const newChunkText = this.postFixChunkText(issue);
    if (list && newChunkText !== null) {
      const delta = issue.replacement.length - (issue.end - issue.start);
      const shifted: IssueDto[] = [];
      for (const other of list) {
        if (other.id === issue.id) continue;
        if (other.start >= issue.end) {
          shifted.push({ ...other, start: other.start + delta, end: other.end + delta });
        } else if (other.end <= issue.start) {
          shifted.push(other);
        }
        // overlapping the applied span — drop
      }
      this.issuesByHash.set(fnvHash(newChunkText), shifted);
    }
    this.scheduleRender();
  }

  /**
   * The chunk text as it reads after the fix. rechunk() already ran via the
   * input event, so the chunk at the same document offset holds the new text.
   * Returns null if the fix changed the chunk boundaries (rare — replacement
   * containing a newline); the chunk is simply re-checked in that case.
   */
  private postFixChunkText(issue: DocIssue): string | null {
    const chunkStart = issue.docStart - issue.start;
    const newChunk = this.chunks.find((c) => c.docOffset === chunkStart);
    if (!newChunk) return null;
    const atFix = newChunk.text.slice(issue.start, issue.start + issue.replacement.length);
    return atFix === issue.replacement ? newChunk.text : null;
  }

  private dismiss(issue: DocIssue): void {
    this.dismissed.add(issue.id);
    this.scheduleRender();
  }

  private report(count: number): void {
    if (count === this.lastReportedCount) return;
    this.lastReportedCount = count;
    this.env.reportCount(count);
  }
}
