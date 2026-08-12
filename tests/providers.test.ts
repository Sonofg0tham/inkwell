// Provider wiring for cloud kinds: URLs, auth, key requirements, registry.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getProvider } from '../lib/providers/registry';
import { ISSUE_JSON_SCHEMA } from '../lib/checker/schema';
import { discardResponse, fetchWithTimeout, ProviderError } from '../lib/providers/types';
import {
  CLOUD_KINDS,
  DEFAULT_BASE_URLS,
  DEFAULT_MODELS,
  PROVIDER_KINDS,
  PROVIDER_LABELS,
  settingsSchema,
} from '../lib/settings/schema';

function okCompletion(content: string) {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('Provider registry & cloud kinds', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async () => okCompletion('{"issues":[]}'));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('schema includes openrouter and gemini as cloud provider kinds', () => {
    expect(PROVIDER_KINDS).toContain('openrouter');
    expect(PROVIDER_KINDS).toContain('gemini');
    expect(CLOUD_KINDS).toContain('openrouter');
    expect(CLOUD_KINDS).toContain('gemini');
    expect(PROVIDER_LABELS.openrouter).toBeTruthy();
    expect(PROVIDER_LABELS.gemini).toBeTruthy();
    expect(DEFAULT_BASE_URLS.openrouter).toBe('https://openrouter.ai/api');
    expect(DEFAULT_BASE_URLS.gemini).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
    expect(DEFAULT_MODELS.openrouter).toBeTruthy();
    expect(DEFAULT_MODELS.gemini).toBeTruthy();
  });

  it('settings schema still parses defaults with the extended kind enum', () => {
    const parsed = settingsSchema.parse({});
    expect(parsed.provider.kind).toBe('ollama');
    const or = settingsSchema.parse({ provider: { kind: 'openrouter', baseUrl: DEFAULT_BASE_URLS.openrouter, model: 'openai/gpt-4o-mini' } });
    expect(or.provider.kind).toBe('openrouter');
  });

  it('registry returns a provider for every kind', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(getProvider(kind)).toBeTruthy();
    }
  });

  it('openrouter completes via /api/v1/chat/completions with Bearer auth', async () => {
    const provider = getProvider('openrouter');
    const result = await provider.complete(
      { kind: 'openrouter', baseUrl: DEFAULT_BASE_URLS.openrouter, model: 'openai/gpt-4o-mini', apiKey: 'sk-or-test' },
      { messages: [{ role: 'user', content: 'hi' }], temperature: 0, maxTokens: 100, signal: new AbortController().signal },
    );
    expect(result.text).toBe('{"issues":[]}');
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-test');
  });

  it('openrouter refuses to run without an API key', async () => {
    const provider = getProvider('openrouter');
    await expect(
      provider.complete(
        { kind: 'openrouter', baseUrl: DEFAULT_BASE_URLS.openrouter, model: 'openai/gpt-4o-mini' },
        { messages: [{ role: 'user', content: 'hi' }], temperature: 0, maxTokens: 100, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: 'auth' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('gemini completes via the /v1beta/openai OpenAI-compat path', async () => {
    const provider = getProvider('gemini');
    await provider.complete(
      { kind: 'gemini', baseUrl: DEFAULT_BASE_URLS.gemini, model: 'gemini-2.5-flash', apiKey: 'AIza-test' },
      { messages: [{ role: 'user', content: 'hi' }], temperature: 0, maxTokens: 100, signal: new AbortController().signal },
    );
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer AIza-test');
    expect(JSON.parse(init.body as string)).not.toHaveProperty('temperature');
  });

  it('gemini lists models via /v1beta/openai/models and strips the models/ prefix', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: 'models/gemini-2.5-flash' }] }), { status: 200 }),
    );
    const provider = getProvider('gemini');
    const models = await provider.listModels({
      kind: 'gemini', baseUrl: DEFAULT_BASE_URLS.gemini, model: 'gemini-2.5-flash', apiKey: 'AIza-test',
    });
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://generativelanguage.googleapis.com/v1beta/openai/models');
    expect(models).toEqual(['gemini-2.5-flash']);
  });

  it('gemini tolerates a models/-prefixed model id in completions', async () => {
    const provider = getProvider('gemini');
    await provider.complete(
      { kind: 'gemini', baseUrl: DEFAULT_BASE_URLS.gemini, model: 'models/gemini-2.5-flash', apiKey: 'AIza-test' },
      { messages: [{ role: 'user', content: 'hi' }], temperature: 0, maxTokens: 100, signal: new AbortController().signal },
    );
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(init.body as string).model).toBe('gemini-2.5-flash');
  });

  it('openrouter testConnection probes the authenticated /v1/key endpoint (models is public)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    const provider = getProvider('openrouter');
    const result = await provider.testConnection({
      kind: 'openrouter', baseUrl: DEFAULT_BASE_URLS.openrouter, model: 'openai/gpt-4o-mini', apiKey: 'sk-or-good',
    });
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/key');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-good');
  });

  it('openrouter testConnection reports an auth failure for a rejected key', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'User not found.', code: 401 } }), { status: 401 }),
    );
    const provider = getProvider('openrouter');
    const result = await provider.testConnection({
      kind: 'openrouter', baseUrl: DEFAULT_BASE_URLS.openrouter, model: 'openai/gpt-4o-mini', apiKey: 'sk-or-bad',
    });
    expect(result).toMatchObject({ ok: false, code: 'auth' });
  });

  it('openrouter testConnection fails fast with no key saved', async () => {
    const provider = getProvider('openrouter');
    const result = await provider.testConnection({
      kind: 'openrouter', baseUrl: DEFAULT_BASE_URLS.openrouter, model: 'openai/gpt-4o-mini',
    });
    expect(result).toMatchObject({ ok: false, code: 'auth' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends OpenAI/OpenRouter a strict-mode-legal schema, not the raw one', async () => {
    const provider = getProvider('openrouter');
    await provider.complete(
      { kind: 'openrouter', baseUrl: DEFAULT_BASE_URLS.openrouter, model: 'm', apiKey: 'k' },
      {
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
        maxTokens: 100,
        jsonSchema: ISSUE_JSON_SCHEMA,
        signal: new AbortController().signal,
      },
    );
    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);

    const item = body.response_format.json_schema.schema.properties.issues.items;
    expect(new Set(item.required)).toEqual(new Set(Object.keys(item.properties)));
    expect(JSON.stringify(body.response_format.json_schema.schema)).not.toContain('maxLength');
  });

  it('sends generic OpenAI-compatible servers plain json_object', async () => {
    const provider = getProvider('openai-compat');
    await provider.complete(
      { kind: 'openai-compat', baseUrl: 'http://localhost:1234', model: 'm' },
      {
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
        maxTokens: 100,
        jsonSchema: ISSUE_JSON_SCHEMA,
        signal: new AbortController().signal,
      },
    );
    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('cancels a rejected compatibility response before retrying without response_format', async () => {
    let releaseCancellation!: () => void;
    const cancelStarted = vi.fn();
    const rejectedBody = new ReadableStream({
      cancel() {
        cancelStarted();
        return new Promise<void>((resolve) => {
          releaseCancellation = resolve;
        });
      },
    });
    fetchSpy
      .mockResolvedValueOnce(new Response(rejectedBody, { status: 400 }))
      .mockResolvedValueOnce(okCompletion('{"issues":[]}'));

    const provider = getProvider('openai-compat');
    const completion = provider.complete(
      { kind: 'openai-compat', baseUrl: 'http://localhost:1234', model: 'm' },
      {
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
        maxTokens: 100,
        jsonSchema: ISSUE_JSON_SCHEMA,
        signal: new AbortController().signal,
      },
    );

    await vi.waitFor(() => expect(cancelStarted).toHaveBeenCalledOnce());
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    releaseCancellation();
    await expect(completion).resolves.toEqual({ text: '{"issues":[]}' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('aborts the first transport when rejected-body cancellation fails before retrying', async () => {
    let firstSignal: AbortSignal | undefined;
    const cancelStarted = vi.fn();
    const rejectedBody = new ReadableStream({
      cancel() {
        cancelStarted();
        return Promise.reject(new Error('transport refused cancellation'));
      },
    });
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (fetchSpy.mock.calls.length === 1) {
        firstSignal = init?.signal ?? undefined;
        return new Response(rejectedBody, { status: 400 });
      }
      expect(firstSignal?.aborted).toBe(true);
      return okCompletion('{"issues":[]}');
    });

    const provider = getProvider('openai-compat');
    await expect(provider.complete(
      { kind: 'openai-compat', baseUrl: 'http://localhost:1234', model: 'm' },
      {
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
        maxTokens: 100,
        jsonSchema: ISSUE_JSON_SCHEMA,
        signal: new AbortController().signal,
      },
    )).resolves.toEqual({ text: '{"issues":[]}' });

    expect(cancelStarted).toHaveBeenCalledOnce();
    expect(firstSignal?.aborted).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('maps overloaded-server responses to a retryable "unavailable" error', async () => {
    for (const status of [500, 502, 503, 504]) {
      fetchSpy.mockResolvedValueOnce(new Response('{}', { status }));
      const provider = getProvider('gemini');
      const result = await provider
        .complete(
          { kind: 'gemini', baseUrl: DEFAULT_BASE_URLS.gemini, model: 'm', apiKey: 'k' },
          { messages: [{ role: 'user', content: 'hi' }], temperature: 0, maxTokens: 10, signal: new AbortController().signal },
        )
        .catch((e) => e);
      expect(result).toBeInstanceOf(ProviderError);
      expect((result as ProviderError).code).toBe('unavailable');
      // The hint must tell the user it is the provider's fault, not theirs.
      expect((result as ProviderError).message).toMatch(/busy|overloaded|try again/i);
    }
  });

  it('cloud providers map HTTP 401 to an auth ProviderError', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    const provider = getProvider('openrouter');
    await expect(
      provider.complete(
        { kind: 'openrouter', baseUrl: DEFAULT_BASE_URLS.openrouter, model: 'openai/gpt-4o-mini', apiKey: 'bad' },
        { messages: [{ role: 'user', content: 'hi' }], temperature: 0, maxTokens: 100, signal: new AbortController().signal },
      ),
    ).rejects.toSatisfy((e: unknown) => e instanceof ProviderError && e.code === 'auth');
  });
});

describe('provider request compatibility', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not require AbortSignal.timeout or AbortSignal.any', async () => {
    const anySpy = vi.spyOn(AbortSignal, 'any').mockImplementation(() => {
      throw new Error('AbortSignal.any is unavailable');
    });
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      throw new Error('AbortSignal.timeout is unavailable');
    });
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(fetchWithTimeout('https://example.test', {})).resolves.toMatchObject({
      status: 200,
    });
    expect(anySpy).not.toHaveBeenCalled();
    expect(timeoutSpy).not.toHaveBeenCalled();
  });

  it('preserves caller cancellation with the compatibility signal', async () => {
    const caller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted.', 'AbortError')),
            { once: true },
          );
          caller.abort();
        });
      }),
    );

    await expect(fetchWithTimeout('https://example.test', {}, caller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('preserves an earlier caller abort when fetch rejects after the deadline', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let rejectFetch!: (reason: unknown) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => await new Promise<Response>((_resolve, reject) => {
        rejectFetch = reject;
      })),
    );

    const result = fetchWithTimeout('https://example.test', {}, caller.signal)
      .catch((error: unknown) => error);
    caller.abort();
    await vi.advanceTimersByTimeAsync(60_001);
    rejectFetch(new DOMException('The operation was aborted.', 'AbortError'));

    await expect(result).resolves.toSatisfy(
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    );
  });

  it('keeps caller cancellation wired after headers arrive while the body is being read', async () => {
    const caller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener(
              'abort',
              () => controller.error(new DOMException('The operation was aborted.', 'AbortError')),
              { once: true },
            );
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const response = await fetchWithTimeout('https://example.test', {}, caller.signal);
    const bodyRead = response.text().then(
      () => 'completed',
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError' ? 'aborted' : 'failed',
    );
    caller.abort();

    await expect(Promise.race([
      bodyRead,
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 50)),
    ])).resolves.toBe('aborted');
  });

  it('keeps the request timeout active after response headers arrive', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener(
              'abort',
              () => controller.error(new DOMException('The operation was aborted.', 'AbortError')),
              { once: true },
            );
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const response = await fetchWithTimeout('https://example.test', {});
    const bodyResult = response.text().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_001);

    await expect(bodyResult).resolves.toSatisfy(
      (error: unknown) => error instanceof ProviderError
        && error.code === 'network'
        && error.message.includes('timed out'),
    );
  });

  it('times out while cancellation of a rejected response body is stalled', async () => {
    vi.useFakeTimers();
    const cancelStarted = vi.fn();
    const body = new ReadableStream({
      cancel() {
        cancelStarted();
        return new Promise<void>(() => undefined);
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 503 })));

    const result = fetchWithTimeout('https://example.test', {}).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_001);

    expect(cancelStarted).toHaveBeenCalledOnce();
    await expect(result).resolves.toSatisfy(
      (error: unknown) => error instanceof ProviderError
        && error.code === 'network'
        && error.message.includes('timed out'),
    );
  });

  it('aborts a successful transport when discarding its unread body fails', async () => {
    let requestSignal: AbortSignal | undefined;
    const cancelStarted = vi.fn();
    const body = new ReadableStream({
      cancel() {
        cancelStarted();
        return Promise.reject(new Error('transport refused cancellation'));
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Response(body, { status: 200 });
      }),
    );

    const response = await fetchWithTimeout('https://example.test', {});
    await discardResponse(response);

    expect(cancelStarted).toHaveBeenCalledOnce();
    expect(requestSignal?.aborted).toBe(true);
  });

  it('times out while discarding a successful response body whose cancellation stalls', async () => {
    vi.useFakeTimers();
    const cancelStarted = vi.fn();
    const body = new ReadableStream({
      cancel() {
        cancelStarted();
        return new Promise<void>(() => undefined);
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));

    const response = await fetchWithTimeout('https://example.test', {});
    let outcome: unknown = 'pending';
    void discardResponse(response).then(
      () => { outcome = 'resolved'; },
      (error: unknown) => { outcome = error; },
    );
    await vi.advanceTimersByTimeAsync(60_001);

    expect(cancelStarted).toHaveBeenCalledOnce();
    expect(outcome).toSatisfy(
      (error: unknown) => error instanceof ProviderError
        && error.code === 'network'
        && error.message.includes('timed out'),
    );
  });
});
