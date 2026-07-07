import {
  ensureOk,
  fetchWithTimeout,
  ProviderError,
  type CompletionRequest,
  type Provider,
  type ResolvedProviderConfig,
  type TestResult,
} from './types';

const ORIGIN_HINT =
  'Ollama rejected the extension (HTTP 403). Restart it with the environment variable ' +
  'OLLAMA_ORIGINS=chrome-extension://* (or OLLAMA_ORIGINS=*) so extensions may connect.';

const NETWORK_HINT = 'Could not reach Ollama. Is it running? Try "ollama serve" in a terminal.';

export const ollamaProvider: Provider = {
  async complete(cfg: ResolvedProviderConfig, req: CompletionRequest) {
    const res = await fetchWithTimeout(
      `${cfg.baseUrl}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          messages: req.messages,
          stream: false,
          ...(req.jsonSchema ? { format: req.jsonSchema } : {}),
          options: { temperature: req.temperature, num_predict: req.maxTokens },
        }),
      },
      req.signal,
      NETWORK_HINT,
    );
    await ensureOk(res, {
      403: { code: 'cors_origin', hint: ORIGIN_HINT },
      404: {
        code: 'not_found',
        hint: `Model "${cfg.model}" not found. Pull it first: ollama pull ${cfg.model}`,
      },
    });
    const json = await res.json();
    const text = json?.message?.content;
    if (typeof text !== 'string') {
      throw new ProviderError('bad_response', 'Ollama returned an unexpected response shape.');
    }
    return { text };
  },

  async listModels(cfg: ResolvedProviderConfig) {
    const res = await fetchWithTimeout(`${cfg.baseUrl}/api/tags`, {}, undefined, NETWORK_HINT);
    await ensureOk(res, { 403: { code: 'cors_origin', hint: ORIGIN_HINT } });
    const json = await res.json();
    const models = Array.isArray(json?.models)
      ? json.models.map((m: { name?: string }) => m?.name).filter((n: unknown): n is string => typeof n === 'string')
      : [];
    return models;
  },

  async testConnection(cfg: ResolvedProviderConfig): Promise<TestResult> {
    try {
      const models = await this.listModels(cfg);
      if (cfg.model && !models.includes(cfg.model)) {
        return {
          ok: false,
          code: 'not_found',
          hint: `Connected, but model "${cfg.model}" isn't pulled. Run: ollama pull ${cfg.model}`,
        };
      }
      return { ok: true };
    } catch (err) {
      if (err instanceof ProviderError) return { ok: false, code: err.code, hint: err.message };
      return { ok: false, code: 'network', hint: NETWORK_HINT };
    }
  },
};
