import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  loadSettings: vi.fn(),
  loadSecret: vi.fn(),
}));

vi.mock('../lib/providers/registry', () => ({
  getProvider: () => ({
    complete: mocks.complete,
    listModels: vi.fn(),
    testConnection: vi.fn(),
  }),
}));

vi.mock('../lib/settings/store', () => ({
  loadSettings: mocks.loadSettings,
  loadSecret: mocks.loadSecret,
}));

import {
  CheckService,
  DEFAULT_CHECK_SERVICE_LIMITS,
  type CheckClient,
} from '../lib/checker/service';
import type { PortResponse } from '../lib/messaging/protocol';

const SETTINGS = {
  enabled: true,
  provider: { kind: 'ollama' as const, baseUrl: 'http://localhost:11434', model: 'test-model' },
  dialect: 'en-GB' as const,
  formality: 'neutral' as const,
  strictness: 'standard' as const,
  categories: { spelling: true, grammar: true, punctuation: true, style: true },
  disabledSites: [],
};

const CLIENT_A: CheckClient = { id: 'client-a', origin: 'https://example.test' };
const CLIENT_B: CheckClient = { id: 'client-b', origin: 'https://example.test' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForCalls(count: number): Promise<void> {
  await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(count));
}

describe('CheckService security boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadSettings.mockResolvedValue(SETTINGS);
    mocks.loadSecret.mockResolvedValue(undefined);
    mocks.complete.mockResolvedValue({ text: '{"issues":[]}' });
  });

  it('keeps identical request IDs independent across clients', async () => {
    const first = deferred<{ text: string }>();
    const second = deferred<{ text: string }>();
    mocks.complete
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const responsesA: PortResponse[] = [];
    const responsesB: PortResponse[] = [];
    const service = new CheckService(() => undefined);

    service.enqueue(CLIENT_A, 'same-id', 'same-hash', 'First clean sentence.', (r) => responsesA.push(r));
    service.enqueue(CLIENT_B, 'same-id', 'same-hash', 'Second clean sentence.', (r) => responsesB.push(r));

    await waitForCalls(2);
    expect(service.inFlightCount).toBe(2);

    first.resolve({ text: '{"issues":[]}' });
    second.resolve({ text: '{"issues":[]}' });
    await vi.waitFor(() => expect(responsesA).toHaveLength(1));
    await vi.waitFor(() => expect(responsesB).toHaveLength(1));
    expect(responsesA[0]?.requestId).toBe('same-id');
    expect(responsesB[0]?.requestId).toBe('same-id');
  });

  it('cancels only the matching client when request IDs collide', async () => {
    const requests: Array<{ signal: AbortSignal; work: ReturnType<typeof deferred<{ text: string }>> }> = [];
    mocks.complete.mockImplementation((_cfg, req) => {
      const work = deferred<{ text: string }>();
      req.signal.addEventListener('abort', () => work.reject(new DOMException('Aborted', 'AbortError')));
      requests.push({ signal: req.signal, work });
      return work.promise;
    });

    const responsesB: PortResponse[] = [];
    const service = new CheckService(() => undefined);
    service.enqueue(CLIENT_A, 'same-id', 'hash-a', 'First clean sentence.', () => undefined);
    service.enqueue(CLIENT_B, 'same-id', 'hash-b', 'Second clean sentence.', (r) => responsesB.push(r));
    await waitForCalls(2);

    service.cancel(CLIENT_A.id, ['same-id']);
    expect(requests[0]?.signal.aborted).toBe(true);
    expect(requests[1]?.signal.aborted).toBe(false);

    requests[1]?.work.resolve({ text: '{"issues":[]}' });
    await vi.waitFor(() => expect(responsesB).toHaveLength(1));
    expect(responsesB[0]?.t).toBe('result');
  });

  it('does not reuse a cached result solely because the client supplied the same hash', async () => {
    const responses: PortResponse[] = [];
    const service = new CheckService(() => undefined);

    service.enqueue(CLIENT_A, 'first', 'attacker-controlled-hash', 'First clean sentence.', (r) => responses.push(r));
    await vi.waitFor(() => expect(responses).toHaveLength(1));

    service.enqueue(CLIENT_A, 'second', 'attacker-controlled-hash', 'Different clean sentence.', (r) => responses.push(r));
    await vi.waitFor(() => expect(responses).toHaveLength(2));

    expect(mocks.complete).toHaveBeenCalledTimes(2);
    expect(responses[1]?.requestId).toBe('second');
  });

  it('rejects an oversized single request before it reaches a provider', async () => {
    const responses: PortResponse[] = [];
    const service = new CheckService(() => undefined, {
      limits: { ...DEFAULT_CHECK_SERVICE_LIMITS, maxRequestChars: 5 },
    });

    service.enqueue(CLIENT_A, 'large', 'hash', '123456', (r) => responses.push(r));

    expect(responses).toEqual([
      expect.objectContaining({ t: 'error', requestId: 'large', code: 'bad_response' }),
    ]);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('enforces a request budget independently for each client', async () => {
    const responsesA: PortResponse[] = [];
    const responsesB: PortResponse[] = [];
    const service = new CheckService(() => undefined, {
      limits: {
        ...DEFAULT_CHECK_SERVICE_LIMITS,
        maxRequestsPerClientWindow: 1,
        maxRequestsPerOriginWindow: 10,
      },
    });

    service.enqueue(CLIENT_A, 'a1', 'h1', 'First clean sentence.', (r) => responsesA.push(r));
    await vi.waitFor(() => expect(responsesA).toHaveLength(1));
    service.enqueue(CLIENT_A, 'a2', 'h2', 'Second clean sentence.', (r) => responsesA.push(r));
    service.enqueue(CLIENT_B, 'b1', 'h3', 'Third clean sentence.', (r) => responsesB.push(r));

    expect(responsesA[1]).toEqual(expect.objectContaining({ t: 'error', code: 'rate_limit' }));
    await vi.waitFor(() => expect(responsesB).toHaveLength(1));
    expect(responsesB[0]?.t).toBe('result');
  });

  it('shares request and text budgets across clients from the same origin', async () => {
    const responses: PortResponse[] = [];
    const service = new CheckService(() => undefined, {
      limits: {
        ...DEFAULT_CHECK_SERVICE_LIMITS,
        maxRequestsPerClientWindow: 10,
        maxTextCharsPerClientWindow: 1_000,
        maxRequestsPerOriginWindow: 1,
        maxTextCharsPerOriginWindow: 1_000,
      },
    });

    service.enqueue(CLIENT_A, 'a1', 'h1', 'First clean sentence.', (r) => responses.push(r));
    await vi.waitFor(() => expect(responses).toHaveLength(1));
    service.enqueue(CLIENT_B, 'b1', 'h2', 'Second clean sentence.', (r) => responses.push(r));

    expect(responses[1]).toEqual(expect.objectContaining({ t: 'error', code: 'rate_limit' }));
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it('bounds pending work per client before adding it to the global queue', async () => {
    const first = deferred<{ text: string }>();
    mocks.complete.mockImplementationOnce(() => first.promise);
    const responses: PortResponse[] = [];
    const service = new CheckService(() => undefined, {
      limits: { ...DEFAULT_CHECK_SERVICE_LIMITS, maxPendingPerClient: 1 },
    });

    service.enqueue(CLIENT_A, 'first', 'h1', 'First clean sentence.', (r) => responses.push(r));
    await waitForCalls(1);
    service.enqueue(CLIENT_A, 'second', 'h2', 'Second clean sentence.', (r) => responses.push(r));

    expect(responses[0]).toEqual(expect.objectContaining({ t: 'error', requestId: 'second', code: 'rate_limit' }));
    expect(service.inFlightCount).toBe(1);
    first.resolve({ text: '{"issues":[]}' });
  });
});
