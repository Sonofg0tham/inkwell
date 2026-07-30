import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECK_PORT } from '../lib/messaging/protocol';
import { DEFAULT_SETTINGS } from '../lib/settings/schema';

const serviceMocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  cancel: vi.fn(),
  cancelClient: vi.fn(),
}));

vi.mock('../lib/checker/service', () => ({
  CheckService: class {
    constructor(_onBusyChange: (busy: boolean) => void) {}
    enqueue(...args: unknown[]) { return serviceMocks.enqueue(...args); }
    cancel(...args: unknown[]) { return serviceMocks.cancel(...args); }
    cancelClient(...args: unknown[]) { return serviceMocks.cancelClient(...args); }
  },
}));

interface Harness {
  connect(port: chrome.runtime.Port): void;
  send(message: unknown, sender?: chrome.runtime.MessageSender): Promise<unknown>;
}

async function setupBackground(storageBoundaryFails = false, storedSettings?: unknown): Promise<Harness> {
  let backgroundMain: (() => void) | undefined;
  let onConnect: ((port: chrome.runtime.Port) => void) | undefined;
  let onMessage:
    | ((message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => unknown)
    | undefined;
  const session = new Map<string, unknown>();

  (globalThis as unknown as { defineBackground: (main: () => void) => unknown }).defineBackground = (main) => {
    backgroundMain = main;
    return main;
  };

  globalThis.chrome = {
    storage: {
      local: {
        setAccessLevel: vi.fn(async () => {
          if (storageBoundaryFails) throw new Error('access-level failed');
        }),
        get: vi.fn(async () => (storedSettings === undefined ? {} : { settings: storedSettings })),
      },
      session: {
        get: vi.fn(async (key: string) => ({ [key]: session.get(key) })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) session.set(key, value);
        }),
      },
      onChanged: { addListener: vi.fn() },
    },
    runtime: {
      id: 'inkwell-test',
      onConnect: { addListener: vi.fn((listener) => { onConnect = listener; }) },
      onMessage: { addListener: vi.fn((listener) => { onMessage = listener; }) },
      getPlatformInfo: vi.fn(async () => ({})),
    },
    action: {
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      setBadgeTextColor: vi.fn(async () => undefined),
      setBadgeText: vi.fn(async () => undefined),
    },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      query: vi.fn(async () => [{ id: 7, url: 'https://example.test/editor' }]),
      sendMessage: vi.fn(async () => undefined),
    },
  } as unknown as typeof chrome;

  await import('../entrypoints/background');
  backgroundMain!();

  return {
    connect: (port) => onConnect!(port),
    send: (message, sender = {}) => new Promise((resolve) => {
      onMessage!(message, sender, resolve);
    }),
  };
}

function makePort(): { port: chrome.runtime.Port; emit(message: unknown): void; postMessage: ReturnType<typeof vi.fn> } {
  let listener: ((message: unknown) => void) | undefined;
  const postMessage = vi.fn();
  const port = {
    name: CHECK_PORT,
    sender: { origin: 'https://example.test', tab: { id: 7 }, frameId: 0 },
    onMessage: { addListener: vi.fn((next) => { listener = next; }) },
    onDisconnect: { addListener: vi.fn() },
    postMessage,
  } as unknown as chrome.runtime.Port;
  return { port, emit: (message) => listener!(message), postMessage };
}

describe('background page state', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('ignores stale frame reports and distinguishes a failed check from a clean page', async () => {
    const runtime = await setupBackground();
    const sender = { tab: { id: 7 }, frameId: 0 } as chrome.runtime.MessageSender;
    await runtime.send({
      t: 'reportFrameState',
      state: { phase: 'error', count: 0, sequence: 2, hint: 'Local model unavailable.' },
    }, sender);
    await runtime.send({
      t: 'reportFrameState',
      state: { phase: 'checked', count: 0, sequence: 1 },
    }, sender);

    const state = await runtime.send({ t: 'getTabState' }) as Record<string, unknown>;
    expect(state).toMatchObject({
      issueCount: 0,
      checkPhase: 'error',
      checkHint: 'Local model unavailable.',
    });
  });

  it('serialises simultaneous frame reports so iframe counts are not lost', async () => {
    const runtime = await setupBackground();
    await Promise.all([
      runtime.send(
        { t: 'reportFrameState', state: { phase: 'checked', count: 1, sequence: 1 } },
        { tab: { id: 7 }, frameId: 0 } as chrome.runtime.MessageSender,
      ),
      runtime.send(
        { t: 'reportFrameState', state: { phase: 'checked', count: 2, sequence: 1 } },
        { tab: { id: 7 }, frameId: 2 } as chrome.runtime.MessageSender,
      ),
    ]);

    const state = await runtime.send({ t: 'getTabState' }) as Record<string, unknown>;
    expect(state).toMatchObject({ issueCount: 3, checkPhase: 'checked' });
  });

  it('starts a fresh sequence when a frame reconnects after navigation', async () => {
    const runtime = await setupBackground();
    const sender = { tab: { id: 7 }, frameId: 0 } as chrome.runtime.MessageSender;
    await runtime.send({
      t: 'reportFrameState',
      state: { phase: 'error', count: 0, sequence: 9, hint: 'Old page failure.' },
    }, sender);

    runtime.connect(makePort().port);
    await runtime.send({
      t: 'reportFrameState',
      state: { phase: 'checked', count: 1, sequence: 1 },
    }, sender);

    const state = await runtime.send({ t: 'getTabState' }) as Record<string, unknown>;
    expect(state).toMatchObject({ issueCount: 1, checkPhase: 'checked' });
  });

  it('treats cloud checking as disabled until the current site is allowed', async () => {
    const runtime = await setupBackground(false, {
      ...DEFAULT_SETTINGS,
      dataConsentVersion: 1,
      provider: { ...DEFAULT_SETTINGS.provider, kind: 'openai' },
      cloudAllowedSites: [],
    });

    const state = await runtime.send({ t: 'getTabState' }) as Record<string, unknown>;
    expect(state).toMatchObject({ host: 'example.test', siteDisabled: true });
  });

  it('fails closed when the trusted storage boundary cannot be established', async () => {
    const runtime = await setupBackground(true);
    const testPort = makePort();
    runtime.connect(testPort.port);
    testPort.emit({ t: 'check', requestId: 'request-1', chunkHash: 'hash-1', text: 'Test text.' });

    await vi.waitFor(() => expect(testPort.postMessage).toHaveBeenCalledTimes(1));
    expect(serviceMocks.enqueue).not.toHaveBeenCalled();
    expect(testPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      t: 'error',
      requestId: 'request-1',
      code: 'bad_response',
    }));
  });
});
