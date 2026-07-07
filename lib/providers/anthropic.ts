import {
  ensureOk,
  fetchWithTimeout,
  ProviderError,
  type CompletionRequest,
  type Provider,
  type ResolvedProviderConfig,
  type TestResult,
} from './types';

const NETWORK_HINT = 'Could not reach api.anthropic.com. Check your internet connection.';

/** Prefill nudges the model straight into the JSON we want. */
const PREFILL = '{"issues":';

function headers(cfg: ResolvedProviderConfig): Record<string, string> {
  if (!cfg.apiKey) {
    throw new ProviderError('auth', 'No API key saved. Add one in Inkwell settings.');
  }
  return {
    'Content-Type': 'application/json',
    'x-api-key': cfg.apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

export const anthropicProvider: Provider = {
  async complete(cfg: ResolvedProviderConfig, req: CompletionRequest) {
    const system = req.messages.find((m) => m.role === 'system')?.content;
    const messages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));
    messages.push({ role: 'assistant', content: PREFILL });

    const res = await fetchWithTimeout(
      `${cfg.baseUrl}/v1/messages`,
      {
        method: 'POST',
        headers: headers(cfg),
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          ...(system ? { system } : {}),
          messages,
        }),
      },
      req.signal,
      NETWORK_HINT,
    );
    await ensureOk(res, {
      404: { code: 'not_found', hint: `Model "${cfg.model}" not found. Check the model name.` },
    });
    const json = await res.json();
    const text = (json as { content?: Array<{ text?: unknown }> })?.content?.[0]?.text;
    if (typeof text !== 'string') {
      throw new ProviderError('bad_response', 'Anthropic returned an unexpected response shape.');
    }
    // Re-prepend the prefill so the parser sees the full JSON object.
    return { text: PREFILL + text };
  },

  async listModels(cfg: ResolvedProviderConfig) {
    const res = await fetchWithTimeout(
      `${cfg.baseUrl}/v1/models`,
      { headers: headers(cfg) },
      undefined,
      NETWORK_HINT,
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
      await this.listModels(cfg);
      return { ok: true };
    } catch (err) {
      if (err instanceof ProviderError) return { ok: false, code: err.code, hint: err.message };
      return { ok: false, code: 'network', hint: NETWORK_HINT };
    }
  },
};
