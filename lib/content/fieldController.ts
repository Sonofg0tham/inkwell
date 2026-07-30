// Per-field orchestration: debounced checking, chunk diffing, underline
// rendering, and the apply/dismiss lifecycle.
import { chunkText, type Chunk } from '../checker/chunker';
import { fnvHash } from '../checker/hash';
import type { FrameCheckState, IssueDto, PortResponse } from '../messaging/protocol';
import type { Settings } from '../settings/schema';
import { applyFix } from './applyFix';
import { getOverlayHost } from './overlay/host';
import { measureTextControl } from './overlay/mirror';
import { SuggestionCard } from './overlay/card';
import { OverlayStatus } from './overlay/status';
import { UnderlineLayer, type SegmentSpec } from './overlay/underlines';
import type { PortClient } from './portClient';
import { buildTextIndex, offsetFromPoint, rangeFromOffsets, type TextIndex } from './textIndex';
import { intersectRect, type DocIssue, type FieldTarget, type Rect } from './types';

export interface FieldEnv {
  getSettings(): Settings;
  port: PortClient;
  reportCount(count: number): void;
  reportStatus?(state: Omit<FrameCheckState, 'sequence'>): void;
  addToDictionary?(word: string): void;
}

const DEBOUNCE_MS = 800;
const LARGE_DOC_CHARS = 20_000;
const LARGE_DOC_WINDOW = 2_500;
const HOVER_SHOW_MS = 150;
const HOVER_HIDE_MS = 300;
const MAX_HASH_ENTRIES = 200;
const SCROLLING_OVERFLOWS = new Set(['auto', 'scroll', 'hidden', 'overlay', 'clip']);

export class FieldController {
  private issuesByHash = new Map<string, IssueDto[]>();
  private dismissed = new Set<string>();
  private ignoredWords = new Set<string>();
  private chunks: Chunk[] = [];
  private pending = new Map<string, string>(); // requestId -> chunkHash
  private currentIssues: DocIssue[] = [];
  private textIndexCache: TextIndex | null = null;
  private lastTextLength = 0;
  private lastReportedCount = -1;
  private userEdited = false;
  private droppedCount = 0;
  private incompleteHint: string | null = null;
  private hasCompletedCheck = false;

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
  private status: OverlayStatus;

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
      onAddToDictionary: this.env.addToDictionary
        ? (word) => this.env.addToDictionary?.(word)
        : undefined,
      onIgnoreAll: (word) => this.ignoreAll(word),
    });
    this.status = new OverlayStatus(host);
  }

  private onInput = (event: Event): void => {
    if (!event.isTrusted) return;
    this.userEdited = true;
    this.handleTextChange();
  };

  private handleTextChange(): void {
    if (this.composing) return;
    this.card.hide();
    this.status.clear();
    this.hasCompletedCheck = false;
    this.droppedCount = 0;
    this.incompleteHint = null;
    this.rechunk();
    this.scheduleRender();
    this.scheduleCheck();
    this.env.reportStatus?.({ phase: 'checking', count: 0 });
  }

  private onCompositionStart = (event: Event): void => {
    if (!event.isTrusted) return;
    this.composing = true;
    this.underlines.clear();
    this.card.hide();
    this.status.clear();
  };

  private onCompositionEnd = (event: Event): void => {
    if (!event.isTrusted) return;
    this.composing = false;
    this.userEdited = true;
    this.handleTextChange();
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
    this.env.reportStatus?.({ phase: 'idle', count: 0 });
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
    this.userEdited = false;
    this.report(0);
    this.env.reportStatus?.({ phase: 'idle', count: 0 });
  }

  settingsChanged(): void {
    clearTimeout(this.debounceTimer);
    if (this.pending.size > 0) {
      this.env.port.cancel([...this.pending.keys()]);
      this.pending.clear();
    }
    this.issuesByHash.clear();
    this.dismissed.clear();
    this.ignoredWords.clear();
    this.currentIssues = [];
    this.droppedCount = 0;
    this.incompleteHint = null;
    this.hasCompletedCheck = false;
    this.card.hide();
    this.underlines.clear();
    this.status.clear();
    this.rechunk();
    this.report(0);
    if (this.active && this.userEdited) {
      this.env.reportStatus?.({ phase: 'checking', count: 0 });
      this.scheduleRender();
      this.scheduleCheck();
    } else {
      this.env.reportStatus?.({ phase: 'idle', count: 0 });
    }
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
    let sent = false;
    for (const chunk of eligible) {
      if (this.issuesByHash.has(chunk.hash) || pendingHashes.has(chunk.hash)) continue;
      const requestId = crypto.randomUUID();
      this.pending.set(requestId, chunk.hash);
      pendingHashes.add(chunk.hash);
      this.env.port.check(requestId, chunk.hash, chunk.text, (resp) =>
        this.onCheckResponse(requestId, resp),
      );
      sent = true;
    }
    if (sent) {
      this.status.announce({ state: 'checking' }, this.statusAnchor());
      this.env.reportStatus?.({ phase: 'checking', count: 0 });
    } else if (this.userEdited && this.pending.size === 0) {
      this.hasCompletedCheck = true;
      this.scheduleRender();
    }
  }

  private onCheckResponse(requestId: string, resp: PortResponse): void {
    this.pending.delete(requestId);
    if (resp.t === 'error') {
      // console.warn, not debug: a silent failure here is indistinguishable
      // from "your writing is fine", which is the worst thing a proofreader
      // can do. The popup surfaces the same failure via Test connection.
      console.warn(`[Inkwell] check failed (${resp.code}): ${resp.hint}`);
      if (this.pending.size > 0) {
        const remaining = [...this.pending.keys()];
        this.pending.clear();
        this.env.port.cancel(remaining);
      }
      this.hasCompletedCheck = false;
      this.status.announce({ state: 'error', message: resp.hint }, this.statusAnchor());
      this.report(0);
      this.env.reportStatus?.({ phase: 'error', count: 0, code: resp.code, hint: resp.hint });
      return;
    }
    this.droppedCount += Math.max(0, Math.trunc(resp.dropped ?? 0));
    if (resp.incomplete) this.incompleteHint ??= resp.incomplete.hint;
    if (resp.dropped && resp.issues.length === 0) {
      console.warn(
        `[Inkwell] the model reported ${resp.dropped} issue(s) but quoted text that is not in the page, ` +
          'so none could be shown. Try a stronger model.',
      );
    }
    this.issuesByHash.set(resp.chunkHash, resp.issues);
    if (this.pending.size === 0) this.hasCompletedCheck = true;
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
        if (
          issue.type === 'spelling' &&
          this.ignoredWords.has(issue.original.toLocaleLowerCase('en'))
        ) {
          continue;
        }
        const docStart = chunk.docOffset + issue.start;
        // The issue id is a hash of the wording, so the same typo in two
        // paragraphs yields the same id. Qualifying it with the document
        // offset keeps each occurrence separately clickable and dismissable —
        // without this, clicking the second underline edits the first one.
        const id = `${issue.id}@${docStart}`;
        if (this.dismissed.has(id)) continue;
        docIssues.push({
          ...issue,
          id,
          docStart,
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
    const visibleCount = new Set(visibleSpecs.map((spec) => spec.issueId)).size;
    this.report(visibleCount);
    if (this.hasCompletedCheck && this.pending.size === 0) {
      if (this.incompleteHint) {
        this.status.announce(
          {
            state: 'partial',
            issueCount: visibleCount,
            droppedCount: this.droppedCount,
            message: this.incompleteHint,
          },
          this.statusAnchor(),
        );
        this.env.reportStatus?.({
          phase: 'partial',
          count: visibleCount,
          hint: this.incompleteHint,
        });
      } else if (this.droppedCount > 0) {
        this.status.announce(
          { state: 'partial', issueCount: visibleCount, droppedCount: this.droppedCount },
          this.statusAnchor(),
        );
        this.env.reportStatus?.({
          phase: 'partial',
          count: visibleCount,
          hint: `${this.droppedCount} model suggestion${this.droppedCount === 1 ? '' : 's'} could not be located safely.`,
        });
      } else {
        this.status.announce({ state: 'checked', issueCount: visibleCount }, this.statusAnchor());
        this.env.reportStatus?.({ phase: 'checked', count: visibleCount });
      }
    }
  }

  private statusAnchor(): Rect {
    const rect = this.target.el.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
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
          list.filter((candidate) => !this.isSourceIssue(candidate, issue)),
        );
      }
      this.scheduleRender();
      return;
    }
    this.userEdited = true;
    this.handleTextChange();
    // The input event from applyFix already re-chunked. Warm the field cache
    // for the post-fix chunk so the paragraph's other underlines survive
    // without another round trip to the model.
    const list = this.issuesByHash.get(issue.chunkHash);
    const newChunkText = this.postFixChunkText(issue);
    if (list && newChunkText !== null) {
      const delta = issue.replacement.length - (issue.end - issue.start);
      const shifted: IssueDto[] = [];
      for (const other of list) {
        if (this.isSourceIssue(other, issue)) continue;
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

  private isSourceIssue(candidate: IssueDto, issue: DocIssue): boolean {
    return (
      `${candidate.id}@${issue.docStart}` === issue.id &&
      candidate.start === issue.start &&
      candidate.end === issue.end &&
      candidate.original === issue.original &&
      candidate.replacement === issue.replacement
    );
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

  private ignoreAll(word: string): void {
    this.ignoredWords.add(word.toLocaleLowerCase('en'));
    this.scheduleRender();
  }

  private report(count: number): void {
    if (count === this.lastReportedCount) return;
    this.lastReportedCount = count;
    this.env.reportCount(count);
  }
}
