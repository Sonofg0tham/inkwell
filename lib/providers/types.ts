import type { ProviderErrorCode } from '../messaging/protocol';
import type { ProviderKind } from '../settings/schema';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  /** JSON Schema for structured output, applied per provider capability. */
  jsonSchema?: Record<string, unknown>;
  signal: AbortSignal;
}

/** Full config as used by the background — apiKey is injected there only. */
export interface ResolvedProviderConfig {
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export type TestResult = { ok: true } | { ok: false; code: ProviderErrorCode; hint: string };

export interface Provider {
  complete(cfg: ResolvedProviderConfig, req: CompletionRequest): Promise<{ text: string }>;
  listModels(cfg: ResolvedProviderConfig): Promise<string[]>;
  testConnection(cfg: ResolvedProviderConfig): Promise<TestResult>;
}

export class ProviderError extends Error {
  constructor(
    public code: ProviderErrorCode,
    /** Safe for UI. Must never contain the API key or a full request body. */
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * fetch wrapper: combines the caller's signal with a 60 s timeout and maps
 * failures to ProviderError with UI-safe messages.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  networkHint = 'Could not reach the server. Is it running?',
): Promise<Response> {
  const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
  if (signal) signals.push(signal);
  try {
    return await fetch(url, { ...init, signal: AbortSignal.any(signals) });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new ProviderError('network', 'The request timed out after 60 seconds.');
    }
    throw new ProviderError('network', networkHint);
  }
}

/** Maps common HTTP status codes to ProviderError. Returns the response if OK. */
export async function ensureOk(
  res: Response,
  hints: Partial<Record<number, { code: ProviderErrorCode; hint: string }>> = {},
): Promise<Response> {
  if (res.ok) return res;
  const special = hints[res.status];
  if (special) throw new ProviderError(special.code, special.hint);
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError('auth', `The server rejected the request (HTTP ${res.status}). Check your API key.`);
  }
  if (res.status === 404) {
    throw new ProviderError('not_found', 'Endpoint or model not found (HTTP 404). Check the base URL and model name.');
  }
  if (res.status === 429) {
    throw new ProviderError('rate_limit', 'Rate limited (HTTP 429). Wait a moment and try again.');
  }
  throw new ProviderError('network', `The server returned HTTP ${res.status}.`);
}
