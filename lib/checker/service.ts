// Background-side check orchestration: queue, concurrency limit, cache,
// cancellation. Lives in the service worker only.
import type { IssueDto, PortResponse } from '../messaging/protocol';
import { getProvider } from '../providers/registry';
import { ProviderError } from '../providers/types';
import { loadSecret, loadSettings } from '../settings/store';
import type { Settings } from '../settings/schema';
import { anchorIssues } from './anchor';
import { LruCache } from './cache';
import { fnvHash } from './hash';
import {
  filterPersonalDictionaryIssues,
  findLocalSpellingIssues,
  mergeLocalSpellingIssues,
} from './localSpelling';
import { findLocalRuleIssues } from './localRules';
import { buildMessages } from './prompt';
import { ISSUE_JSON_SCHEMA, parseIssuesDetailed } from './schema';

const MAX_CONCURRENT = 2;
const CACHE_MAX = 500;
const RETRY_DELAY_MS = 1500;

export interface CheckClient {
  /** Background-generated identity for one runtime Port. Never supplied by a page. */
  id: string;
  /** Sender origin when Chrome can identify it. Used to stop multi-frame budget bypasses. */
  origin?: string;
}

export interface CheckServiceLimits {
  /** A single provider call must remain within the local model's practical context window. */
  maxRequestChars: number;
  /** Queued plus active work owned by one Port. */
  maxPendingPerClient: number;
  /** Queued plus active work across all frames and tabs on one origin. */
  maxPendingPerOrigin: number;
  budgetWindowMs: number;
  maxRequestsPerClientWindow: number;
  maxTextCharsPerClientWindow: number;
  maxRequestsPerOriginWindow: number;
  maxTextCharsPerOriginWindow: number;
}

export const DEFAULT_CHECK_SERVICE_LIMITS: Readonly<CheckServiceLimits> = {
  maxRequestChars: 12_000,
  maxPendingPerClient: 16,
  maxPendingPerOrigin: 48,
  budgetWindowMs: 60_000,
  maxRequestsPerClientWindow: 90,
  maxTextCharsPerClientWindow: 180_000,
  maxRequestsPerOriginWindow: 180,
  maxTextCharsPerOriginWindow: 360_000,
};

export interface CheckServiceOptions {
  limits?: CheckServiceLimits;
  /** Injectable clock keeps the rolling-window policy deterministic in tests. */
  now?: () => number;
}

interface QueueItem {
  client: CheckClient;
  requestId: string;
  chunkHash: string;
  text: string;
  respond: (r: PortResponse) => void;
  controller: AbortController;
}

function settingsFingerprint(settings: Settings): string {
  return fnvHash(
    JSON.stringify({
      kind: settings.provider.kind,
      baseUrl: settings.provider.baseUrl,
      model: settings.provider.model,
      dialect: settings.dialect,
      formality: settings.formality,
      strictness: settings.strictness,
      categories: settings.categories,
      personalDictionary: settings.personalDictionary,
    }),
  );
}

interface CachedResult {
  /** FNV is only an index. Exact equality is the cache's trust boundary. */
  sourceText: string;
  issues: IssueDto[];
  dropped: number;
  droppedReasons: string[];
  model: string;
}

interface BudgetWindow {
  startedAt: number;
  requests: number;
  chars: number;
}

function isTrustedExtensionClient(client: CheckClient): boolean {
  try {
    return new URL(client.origin ?? '').protocol === 'chrome-extension:';
  } catch {
    return false;
  }
}

export class CheckService {
  private queue: QueueItem[] = [];
  // A Set tracks the actual work items. Keying this by a caller-supplied ID
  // lets two frames overwrite each other and makes cross-client cancellation
  // possible when their per-context counters produce the same value.
  private active = new Set<QueueItem>();
  private cache = new LruCache<CachedResult>(CACHE_MAX);
  private clientBudgets = new Map<string, BudgetWindow>();
  private originBudgets = new Map<string, BudgetWindow>();
  private limits: CheckServiceLimits;
  private now: () => number;

  constructor(
    private onBusyChange: (busy: boolean) => void,
    options: CheckServiceOptions = {},
  ) {
    this.limits = options.limits ?? { ...DEFAULT_CHECK_SERVICE_LIMITS };
    this.now = options.now ?? Date.now;
  }

  get inFlightCount(): number {
    return this.active.size + this.queue.length;
  }

  enqueue(
    client: CheckClient,
    requestId: string,
    chunkHash: string,
    text: string,
    respond: (r: PortResponse) => void,
  ): void {
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 160) {
      respond({ t: 'error', requestId: String(requestId), code: 'bad_response', hint: 'Invalid request identifier.' });
      return;
    }
    if (typeof text !== 'string' || text.length > this.limits.maxRequestChars) {
      respond({
        t: 'error',
        requestId,
        code: 'bad_response',
        hint: `This text is too long for one check. Split it into sections of ${this.limits.maxRequestChars.toLocaleString('en-GB')} characters or fewer.`,
      });
      return;
    }
    if (this.hasRequest(client.id, requestId)) {
      respond({ t: 'error', requestId, code: 'bad_response', hint: 'Duplicate request identifier.' });
      return;
    }
    if (this.pendingForClient(client.id) >= this.limits.maxPendingPerClient) {
      this.rejectForBudget(requestId, respond, 'Too many checks are already pending for this editor.');
      return;
    }
    if (
      client.origin &&
      this.pendingForOrigin(client.origin) >= this.limits.maxPendingPerOrigin
    ) {
      this.rejectForBudget(requestId, respond, 'Too many checks are already pending for this site.');
      return;
    }
    const budgetFailure = this.consumeBudget(client, text.length);
    if (budgetFailure) {
      this.rejectForBudget(requestId, respond, budgetFailure);
      return;
    }

    this.queue.push({ client, requestId, chunkHash, text, respond, controller: new AbortController() });
    this.pump();
  }

  cancel(clientId: string, requestIds: string[]): void {
    const ids = new Set(requestIds);
    this.queue = this.queue.filter(
      (item) => item.client.id !== clientId || !ids.has(item.requestId),
    );
    for (const item of this.active) {
      if (item.client.id === clientId && ids.has(item.requestId)) item.controller.abort();
    }
    this.notifyBusy();
  }

  cancelClient(clientId: string): void {
    this.queue = this.queue.filter((item) => item.client.id !== clientId);
    for (const item of this.active) {
      if (item.client.id === clientId) item.controller.abort();
    }
    this.clientBudgets.delete(clientId);
    this.notifyBusy();
  }

  cancelAll(): void {
    this.queue = [];
    for (const item of this.active) item.controller.abort();
    this.notifyBusy();
  }

  private rejectForBudget(
    requestId: string,
    respond: (r: PortResponse) => void,
    hint: string,
  ): void {
    respond({ t: 'error', requestId, code: 'rate_limit', hint });
  }

  private hasRequest(clientId: string, requestId: string): boolean {
    return (
      this.queue.some((item) => item.client.id === clientId && item.requestId === requestId) ||
      [...this.active].some((item) => item.client.id === clientId && item.requestId === requestId)
    );
  }

  private pendingForClient(clientId: string): number {
    let count = this.queue.filter((item) => item.client.id === clientId).length;
    for (const item of this.active) if (item.client.id === clientId) count++;
    return count;
  }

  private pendingForOrigin(origin: string): number {
    let count = this.queue.filter((item) => item.client.origin === origin).length;
    for (const item of this.active) if (item.client.origin === origin) count++;
    return count;
  }

  private currentBudget(map: Map<string, BudgetWindow>, key: string, now: number): BudgetWindow {
    const existing = map.get(key);
    if (existing && now - existing.startedAt < this.limits.budgetWindowMs) return existing;
    const fresh = { startedAt: now, requests: 0, chars: 0 };
    map.set(key, fresh);
    // A long-lived service worker can see many origins. Retain active windows,
    // but discard expired history before the map itself becomes a memory sink.
    if (map.size > 512) {
      for (const [candidate, window] of map) {
        if (now - window.startedAt >= this.limits.budgetWindowMs) map.delete(candidate);
      }
    }
    return fresh;
  }

  private consumeBudget(client: CheckClient, chars: number): string | null {
    // CheckClient identity and origin are created by the background worker,
    // never accepted from page code. The document workspace still goes
    // through request-size, pending-work and global concurrency limits, but it
    // must be able to drain documents larger than a web editor's abuse budget.
    if (isTrustedExtensionClient(client)) return null;

    const now = this.now();
    const clientWindow = this.currentBudget(this.clientBudgets, client.id, now);
    const originWindow = client.origin
      ? this.currentBudget(this.originBudgets, client.origin, now)
      : undefined;

    if (
      clientWindow.requests + 1 > this.limits.maxRequestsPerClientWindow ||
      clientWindow.chars + chars > this.limits.maxTextCharsPerClientWindow
    ) {
      return 'This editor has reached Inkwell\'s one-minute checking budget. Pause briefly, then continue.';
    }
    if (
      originWindow &&
      (originWindow.requests + 1 > this.limits.maxRequestsPerOriginWindow ||
        originWindow.chars + chars > this.limits.maxTextCharsPerOriginWindow)
    ) {
      return 'This site has reached Inkwell\'s one-minute checking budget. Pause briefly, then continue.';
    }

    clientWindow.requests++;
    clientWindow.chars += chars;
    if (originWindow) {
      originWindow.requests++;
      originWindow.chars += chars;
    }
    return null;
  }

  private notifyBusy(): void {
    this.onBusyChange(this.inFlightCount > 0);
  }

  private pump(): void {
    this.notifyBusy();
    while (this.active.size < MAX_CONCURRENT && this.queue.length > 0) {
      // Newest first — the user cares about what they just typed.
      const item = this.queue.pop()!;
      this.active.add(item);
      void this.run(item).finally(() => {
        this.active.delete(item);
        this.pump();
      });
    }
  }

  /** One free retry for blips (503s especially) before bothering the user. */
  private async completeWithRetry(
    provider: ReturnType<typeof getProvider>,
    cfg: Parameters<ReturnType<typeof getProvider>['complete']>[0],
    req: Parameters<ReturnType<typeof getProvider>['complete']>[1],
  ): Promise<{ text: string }> {
    try {
      return await provider.complete(cfg, req);
    } catch (err) {
      const retryable =
        err instanceof ProviderError && (err.code === 'unavailable' || err.code === 'rate_limit');
      if (!retryable || req.signal.aborted) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      if (req.signal.aborted) throw err;
      return provider.complete(cfg, req);
    }
  }

  private async run(item: QueueItem): Promise<void> {
    try {
      const settings = await loadSettings();
      if (item.controller.signal.aborted) return;
      // The sender's hash is useful only for mapping the response back to its
      // field. The cache computes its own index and then verifies exact text,
      // so a collision or forged hash cannot return another document's result.
      const cacheKey = `${fnvHash(item.text)}:${settingsFingerprint(settings)}`;
      const cached = this.cache.get(cacheKey);
      if (cached?.sourceText === item.text) {
        item.respond({
          t: 'result',
          requestId: item.requestId,
          chunkHash: item.chunkHash,
          issues: cached.issues,
          dropped: cached.dropped,
          droppedReasons: cached.droppedReasons,
          model: cached.model,
        });
        return;
      }
      const cfg = {
        ...settings.provider,
        apiKey: await loadSecret(settings.provider.kind),
      };
      if (item.controller.signal.aborted) return;
      const localIssues = mergeLocalSpellingIssues(
        findLocalSpellingIssues(item.text, settings),
        findLocalRuleIssues(item.text, settings),
      );
      const provider = getProvider(cfg.kind);
      let responseText: string;
      try {
        ({ text: responseText } = await this.completeWithRetry(provider, cfg, {
          messages: buildMessages(settings, item.text),
          temperature: 0,
          maxTokens: 2048,
          jsonSchema: ISSUE_JSON_SCHEMA,
          signal: item.controller.signal,
        }));
      } catch (err) {
        if (item.controller.signal.aborted) return;
        if (localIssues.length === 0) throw err;
        item.respond({
          t: 'result',
          requestId: item.requestId,
          chunkHash: item.chunkHash,
          issues: localIssues,
          dropped: 0,
          droppedReasons: [],
          model: cfg.model,
          incomplete: {
            code: err instanceof ProviderError ? err.code : 'network',
            hint: err instanceof Error ? err.message : 'The contextual model check failed.',
          },
        });
        return;
      }
      const parsed = parseIssuesDetailed(responseText);
      // Standard mode promises clear errors only. Enforce that boundary after
      // parsing so a model cannot surface style suggestions by ignoring the prompt.
      const effectiveCategories =
        settings.strictness === 'standard'
          ? { ...settings.categories, style: false }
          : settings.categories;
      const anchored = anchorIssues(item.text, parsed.issues, effectiveCategories);
      const issues = mergeLocalSpellingIssues(
        localIssues,
        filterPersonalDictionaryIssues(anchored.issues, settings),
      );
      // Malformed items and unplaceable items are both "the model found
      // something we can't show you" — they must reach the UI the same way.
      const dropped = anchored.dropped + parsed.rejected;
      const droppedReasons = [...parsed.reasons];
      if (anchored.dropped > 0) {
        droppedReasons.push('the quoted text was not found in the document');
      }
      const result: CachedResult = {
        sourceText: item.text,
        issues,
        dropped,
        droppedReasons,
        model: cfg.model,
      };
      this.cache.set(cacheKey, result);
      item.respond({
        t: 'result',
        requestId: item.requestId,
        chunkHash: item.chunkHash,
        issues,
        dropped,
        droppedReasons,
        model: cfg.model,
      });
    } catch (err) {
      if (item.controller.signal.aborted) return; // cancelled — stay silent
      const code = err instanceof ProviderError ? err.code : 'network';
      const hint = err instanceof Error ? err.message : 'Unknown error';
      item.respond({ t: 'error', requestId: item.requestId, code, hint });
    }
  }
}
