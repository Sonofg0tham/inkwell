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

function createRequestSignal(callerSignal?: AbortSignal): {
  signal: AbortSignal;
  didTimeOut: () => boolean;
  abort: () => void;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  let disposed = false;
  const abortFromCaller = (): void => controller.abort();

  if (callerSignal?.aborted) {
    controller.abort();
  } else {
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  }

  const timeout = setTimeout(() => {
    if (controller.signal.aborted) {
      callerSignal?.removeEventListener('abort', abortFromCaller);
      return;
    }
    timedOut = true;
    controller.abort();
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }, REQUEST_TIMEOUT_MS);

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    abort: () => controller.abort(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

type RequestScope = ReturnType<typeof createRequestSignal>;
const BODY_READ_METHODS = new Set(['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text']);
interface ResponseCleanup {
  discard: () => Promise<void>;
}
const responseCleanups = new WeakMap<Response, ResponseCleanup>();

async function cancelResponseBody(
  response: Response,
  request: RequestScope,
): Promise<void> {
  const body = response.body;
  if (!body) return;

  let rejectOnAbort = (): void => undefined;
  const abortError = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = (): void => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    if (request.signal.aborted) {
      rejectOnAbort();
      return;
    }
    request.signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  // A transport can fail while its error body is still streaming. Start
  // cancellation before a compatibility retry, but keep the request deadline
  // able to break a cancellation promise that never settles.
  const cancellation = Promise.resolve().then(() => body.cancel());
  try {
    try {
      await Promise.race([cancellation, abortError]);
    } catch (error) {
      if (request.signal.aborted) throw error;
      // Some stream implementations reject cancel() without closing their
      // transport. Abort the original fetch before any compatibility retry.
      request.abort();
    }
  } finally {
    request.signal.removeEventListener('abort', rejectOnAbort);
  }
}

function requestError(
  err: unknown,
  request: RequestScope,
  callerSignal: AbortSignal | undefined,
  networkHint: string,
): Error {
  if (request.didTimeOut()) {
    return new ProviderError('network', 'The request timed out after 60 seconds.');
  }
  if (err instanceof DOMException && err.name === 'AbortError') return err;
  if (callerSignal?.aborted) {
    return new DOMException('The operation was aborted.', 'AbortError');
  }
  return err instanceof Error ? err : new ProviderError('network', networkHint);
}

function keepRequestAliveThroughBody(
  response: Response,
  request: RequestScope,
  callerSignal: AbortSignal | undefined,
  networkHint: string,
): Response {
  const release = (): void => {
    request.dispose();
    responseCleanups.delete(managed);
  };
  const discard = async (): Promise<void> => {
    try {
      await cancelResponseBody(response, request);
    } catch (err) {
      throw requestError(err, request, callerSignal, networkHint);
    } finally {
      release();
    }
  };
  const managed = new Proxy(response, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const bound = value.bind(target) as (...args: unknown[]) => unknown;
      if (typeof property !== 'string' || !BODY_READ_METHODS.has(property)) return bound;
      return async (...args: unknown[]) => {
        try {
          return await bound(...args);
        } catch (err) {
          throw requestError(err, request, callerSignal, networkHint);
        } finally {
          release();
        }
      };
    },
  });
  responseCleanups.set(managed, { discard });
  return managed;
}

/** Releases a successful response that the caller deliberately does not read. */
export async function discardResponse(response: Response): Promise<void> {
  const cleanup = responseCleanups.get(response);
  if (cleanup) {
    await cleanup.discard();
    return;
  }
  try {
    await response.body?.cancel();
  } catch {
    // An unmanaged, already consumed or closed response needs no request cleanup.
  }
}

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
  // Combine the caller cancellation and timeout explicitly so the behaviour
  // stays consistent and testable across every supported Chromium build.
  const request = createRequestSignal(signal);
  try {
    const response = await fetch(url, { ...init, signal: request.signal });
    if (!response.ok) {
      await cancelResponseBody(response, request);
      request.dispose();
      return response;
    }
    return keepRequestAliveThroughBody(response, request, signal, networkHint);
  } catch (err) {
    const mapped = requestError(err, request, signal, networkHint);
    request.dispose();
    if (mapped instanceof ProviderError || mapped instanceof DOMException) throw mapped;
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
  if (res.status >= 500 && res.status < 600) {
    // The provider is up but struggling — common on free tiers at peak times.
    // Nothing for the user to fix, so say so and let the checker retry.
    throw new ProviderError(
      'unavailable',
      `The model provider is busy or overloaded (HTTP ${res.status}). Inkwell will try again shortly.`,
    );
  }
  throw new ProviderError('network', `The server returned HTTP ${res.status}.`);
}
