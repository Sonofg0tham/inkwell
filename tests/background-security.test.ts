import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECK_PORT } from '../lib/messaging/protocol';
import { CURRENT_DATA_CONSENT_VERSION, DEFAULT_SETTINGS } from '../lib/settings/schema';

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

interface TestPort {
  port: chrome.runtime.Port;
  emitMessage(message: unknown): void;
  emitDisconnect(): void;
}

function makePort(origin: string, tabId: number, frameId: number): TestPort {
  const messageListeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const port = {
    name: CHECK_PORT,
    sender: { origin, tab: { id: tabId }, frameId },
    onMessage: {
      addListener: (listener: (message: unknown) => void) => messageListeners.add(listener),
    },
    onDisconnect: {
      addListener: (listener: () => void) => disconnectListeners.add(listener),
    },
    postMessage: vi.fn(),
  } as unknown as chrome.runtime.Port;
  return {
    port,
    emitMessage: (message) => messageListeners.forEach((listener) => listener(message)),
    emitDisconnect: () => disconnectListeners.forEach((listener) => listener()),
  };
}

describe('background security boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('restricts local storage and gives every Port an origin-scoped client identity', async () => {
    let backgroundMain: (() => void) | undefined;
    let onConnect: ((port: chrome.runtime.Port) => void) | undefined;

    (globalThis as unknown as { defineBackground: (main: () => void) => unknown }).defineBackground = (main) => {
      backgroundMain = main;
      return main;
    };

    const setAccessLevel = vi.fn(async () => undefined);
    globalThis.chrome = {
      storage: {
        local: {
          setAccessLevel,
          get: vi.fn(async () => ({
            settings: {
              ...DEFAULT_SETTINGS,
              dataConsentVersion: CURRENT_DATA_CONSENT_VERSION,
            },
          })),
        },
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
        },
      },
      runtime: {
        id: 'inkwell-test',
        onConnect: { addListener: vi.fn((listener) => { onConnect = listener; }) },
        onMessage: { addListener: vi.fn() },
        getPlatformInfo: vi.fn(async () => ({})),
      },
      action: {
        setBadgeBackgroundColor: vi.fn(async () => undefined),
        setBadgeTextColor: vi.fn(async () => undefined),
        setBadgeText: vi.fn(async () => undefined),
      },
      tabs: {
        onRemoved: { addListener: vi.fn() },
        query: vi.fn(async () => []),
      },
    } as unknown as typeof chrome;

    await import('../entrypoints/background');
    expect(backgroundMain).toBeTypeOf('function');
    backgroundMain!();

    await vi.waitFor(() => {
      expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    });

    const first = makePort('https://example.test', 7, 0);
    const second = makePort('https://example.test', 7, 2);
    onConnect!(first.port);
    onConnect!(second.port);

    first.emitMessage({ t: 'check', requestId: 'same-id', chunkHash: 'h1', text: 'First sentence.' });
    second.emitMessage({ t: 'check', requestId: 'same-id', chunkHash: 'h2', text: 'Second sentence.' });

    await vi.waitFor(() => expect(serviceMocks.enqueue).toHaveBeenCalledTimes(2));
    const firstClient = serviceMocks.enqueue.mock.calls[0]?.[0];
    const secondClient = serviceMocks.enqueue.mock.calls[1]?.[0];
    expect(firstClient).toEqual(expect.objectContaining({ origin: 'https://example.test' }));
    expect(secondClient).toEqual(expect.objectContaining({ origin: 'https://example.test' }));
    expect(firstClient.id).not.toBe(secondClient.id);

    first.emitMessage({ t: 'cancel', requestIds: ['same-id'] });
    expect(serviceMocks.cancel).toHaveBeenCalledWith(firstClient.id, ['same-id']);
    first.emitDisconnect();
    expect(serviceMocks.cancelClient).toHaveBeenCalledWith(firstClient.id);
  });
});
