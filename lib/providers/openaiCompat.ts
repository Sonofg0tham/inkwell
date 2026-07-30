import { toStrictJsonSchema } from '../checker/schema';
import {
  ensureOk,
  fetchWithTimeout,
  ProviderError,
  type CompletionRequest,
  type Provider,
  type ResolvedProviderConfig,
  type TestResult,
} from './types';

interface CompatOptions {
  /** OpenAI proper supports strict json_schema; generic servers get json_object. */
  strictJsonSchema: boolean;
  requireKey: boolean;
  networkHint: string;
  /**
   * Path prefix between baseUrl and /chat/completions. Defaults to '/v1'.
   * Gemini's OpenAI-compat endpoint already carries its prefix in the base URL
   * (…/v1beta/openai), so it uses ''.
   */
  apiPath?: string;
  /** Canonicalises model ids in requests and listings (e.g. Gemini's models/ prefix). */
  normalizeModelId?: (id: string) => string;
  /** Some compatibility APIs reject sampling controls for newer models. */
  includeTemperature?: boolean;
}

function authHeaders(cfg: ResolvedProviderConfig, requireKey: boolean): Record<string, string> {
  if (requireKey && !cfg.apiKey) {
    throw new ProviderError('auth', 'No API key saved. Add one in Inkwell settings.');
  }
  return cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
}

function extractText(json: unknown): string {
  const text = (json as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]
    ?.message?.content;
  if (typeof text !== 'string') {
    throw new ProviderError('bad_response', 'The server returned an unexpected response shape.');
  }
  return text;
}

export function createOpenAICompatProvider(opts: CompatOptions): Provider {
  const apiPath = opts.apiPath ?? '/v1';
  const normalize = opts.normalizeModelId ?? ((id: string) => id);
  const provider: Provider = {
    async complete(cfg: ResolvedProviderConfig, req: CompletionRequest) {
      const body: Record<string, unknown> = {
        model: normalize(cfg.model),
        messages: req.messages,
        ...(opts.includeTemperature === false ? {} : { temperature: req.temperature }),
        max_tokens: req.maxTokens,
      };
      if (req.jsonSchema) {
        body.response_format = opts.strictJsonSchema
          ? {
              type: 'json_schema',
              // Strict mode rejects optional properties and most validation
              // keywords; sending the raw schema 400s and costs us enforcement.
              json_schema: {
                name: 'issues',
                strict: true,
                schema: toStrictJsonSchema(req.jsonSchema),
              },
            }
          : { type: 'json_object' };
      }

      const doFetch = (payload: Record<string, unknown>) =>
        fetchWithTimeout(
          `${cfg.baseUrl}${apiPath}/chat/completions`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders(cfg, opts.requireKey) },
            body: JSON.stringify(payload),
          },
          req.signal,
          opts.networkHint,
        );

      let res = await doFetch(body);
      // Some OpenAI-compatible servers reject response_format — retry once without it.
      if (res.status === 400 && body.response_format) {
        const { response_format: _dropped, ...withoutFormat } = body;
        res = await doFetch(withoutFormat);
      }
      await ensureOk(res);
      return { text: extractText(await res.json()) };
    },

    async listModels(cfg: ResolvedProviderConfig) {
      const res = await fetchWithTimeout(
        `${cfg.baseUrl}${apiPath}/models`,
        { headers: authHeaders(cfg, opts.requireKey) },
        undefined,
        opts.networkHint,
      );
      await ensureOk(res);
      const json = await res.json();
      const data = (json as { data?: Array<{ id?: unknown }> })?.data;
      return Array.isArray(data)
        ? data
            .map((m) => m?.id)
            .filter((id): id is string => typeof id === 'string')
            .map(normalize)
        : [];
    },

    async testConnection(cfg: ResolvedProviderConfig): Promise<TestResult> {
      try {
        await provider.listModels(cfg);
        return { ok: true };
      } catch (err) {
        if (err instanceof ProviderError) return { ok: false, code: err.code, hint: err.message };
        return { ok: false, code: 'network', hint: opts.networkHint };
      }
    },
  };
  return provider;
}

export const lmStudioProvider = createOpenAICompatProvider({
  strictJsonSchema: false,
  requireKey: false,
  networkHint:
    'Could not reach the server. If you use LM Studio: start its local server and enable ' +
    'CORS in the server settings, then try again.',
});

export const openaiProvider = createOpenAICompatProvider({
  strictJsonSchema: true,
  requireKey: true,
  networkHint: 'Could not reach api.openai.com. Check your internet connection.',
});

const OPENROUTER_HINT = 'Could not reach openrouter.ai. Check your internet connection.';

const openrouterBase = createOpenAICompatProvider({
  strictJsonSchema: true,
  requireKey: true,
  networkHint: OPENROUTER_HINT,
});

/**
 * OpenRouter speaks the OpenAI API at openrouter.ai/api/v1. Models that don't
 * support response_format are handled by the existing 400-retry fallback.
 *
 * Its /v1/models endpoint is public, so listing models proves nothing about
 * the key — testConnection probes the authenticated /v1/key endpoint instead,
 * which returns 401 for a missing or invalid key.
 */
export const openrouterProvider: Provider = {
  ...openrouterBase,
  async testConnection(cfg: ResolvedProviderConfig): Promise<TestResult> {
    try {
      const res = await fetchWithTimeout(
        `${cfg.baseUrl}/v1/key`,
        { headers: authHeaders(cfg, true) },
        undefined,
        OPENROUTER_HINT,
      );
      await ensureOk(res);
      return { ok: true };
    } catch (err) {
      if (err instanceof ProviderError) return { ok: false, code: err.code, hint: err.message };
      return { ok: false, code: 'network', hint: OPENROUTER_HINT };
    }
  },
};

/**
 * Gemini's OpenAI-compat layer lives under /v1beta/openai (no extra /v1).
 * Its model listing returns "models/gemini-…" ids while completions want the
 * bare name, so ids are normalised in both directions.
 */
export const geminiProvider = createOpenAICompatProvider({
  strictJsonSchema: false,
  requireKey: true,
  apiPath: '',
  networkHint: 'Could not reach the Gemini API. Check your internet connection.',
  normalizeModelId: (id) => id.replace(/^models\//, ''),
  includeTemperature: false,
});
