// Background-side check orchestration: queue, concurrency limit, cache,
// cancellation. Lives in the service worker only.
import type { IssueDto, PortResponse } from '../messaging/protocol';
import { getProvider } from '../providers/registry';
import { ProviderError } from '../providers/types';
import { loadSecret, loadSettings } from '../settings/store';
import type { Settings } from '../settings/schema';
import { locateIssues } from './anchor';
import { LruCache } from './cache';
import { fnvHash } from './hash';
import { buildMessages } from './prompt';
import { ISSUE_JSON_SCHEMA, parseIssues } from './schema';

const MAX_CONCURRENT = 2;
const CACHE_MAX = 500;

interface QueueItem {
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
    }),
  );
}

export class CheckService {
  private queue: QueueItem[] = [];
  private active = new Map<string, QueueItem>();
  private cache = new LruCache<IssueDto[]>(CACHE_MAX);

  constructor(private onBusyChange: (busy: boolean) => void) {}

  get inFlightCount(): number {
    return this.active.size + this.queue.length;
  }

  async enqueue(
    requestId: string,
    chunkHash: string,
    text: string,
    respond: (r: PortResponse) => void,
  ): Promise<void> {
    const settings = await loadSettings();
    const cacheKey = `${chunkHash}:${settingsFingerprint(settings)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      respond({ t: 'result', requestId, chunkHash, issues: cached });
      return;
    }
    this.queue.push({ requestId, chunkHash, text, respond, controller: new AbortController() });
    this.pump();
  }

  cancel(requestIds: string[]): void {
    const ids = new Set(requestIds);
    this.queue = this.queue.filter((item) => !ids.has(item.requestId));
    for (const [id, item] of this.active) {
      if (ids.has(id)) item.controller.abort();
    }
    this.notifyBusy();
  }

  cancelAll(): void {
    this.queue = [];
    for (const item of this.active.values()) item.controller.abort();
    this.notifyBusy();
  }

  private notifyBusy(): void {
    this.onBusyChange(this.inFlightCount > 0);
  }

  private pump(): void {
    this.notifyBusy();
    while (this.active.size < MAX_CONCURRENT && this.queue.length > 0) {
      // Newest first — the user cares about what they just typed.
      const item = this.queue.pop()!;
      this.active.set(item.requestId, item);
      void this.run(item).finally(() => {
        this.active.delete(item.requestId);
        this.pump();
      });
    }
  }

  private async run(item: QueueItem): Promise<void> {
    try {
      const settings = await loadSettings();
      const cfg = {
        ...settings.provider,
        apiKey: await loadSecret(settings.provider.kind),
      };
      const provider = getProvider(cfg.kind);
      const { text: responseText } = await provider.complete(cfg, {
        messages: buildMessages(settings, item.text),
        temperature: 0,
        maxTokens: 2048,
        jsonSchema: ISSUE_JSON_SCHEMA,
        signal: item.controller.signal,
      });
      const raw = parseIssues(responseText);
      const issues = locateIssues(item.text, raw, settings.categories);
      this.cache.set(`${item.chunkHash}:${settingsFingerprint(settings)}`, issues);
      item.respond({ t: 'result', requestId: item.requestId, chunkHash: item.chunkHash, issues });
    } catch (err) {
      if (item.controller.signal.aborted) return; // cancelled — stay silent
      const code = err instanceof ProviderError ? err.code : 'network';
      const hint = err instanceof Error ? err.message : 'Unknown error';
      item.respond({ t: 'error', requestId: item.requestId, code, hint });
    }
  }
}
