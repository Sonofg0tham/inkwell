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
  const provider: Provider = {
    async complete(cfg: ResolvedProviderConfig, req: CompletionRequest) {
      const body: Record<string, unknown> = {
        model: cfg.model,
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.maxTokens,
      };
      if (req.jsonSchema) {
        body.response_format = opts.strictJsonSchema
          ? {
              type: 'json_schema',
              json_schema: { name: 'issues', strict: true, schema: req.jsonSchema },
            }
          : { type: 'json_object' };
      }

      const doFetch = (payload: Record<string, unknown>) =>
        fetchWithTimeout(
          `${cfg.baseUrl}/v1/chat/completions`,
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
        `${cfg.baseUrl}/v1/models`,
        { headers: authHeaders(cfg, opts.requireKey) },
        undefined,
        opts.networkHint,
      );
      await ensureOk(res);
      const json = await res.json();
      const data = (json as { data?: Array<{ id?: unknown }> })?.data;
      return Array.isArray(data)
        ? data.map((m) => m?.id).filter((id): id is string => typeof id === 'string')
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
