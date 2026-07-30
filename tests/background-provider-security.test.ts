import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECK_PORT } from '../lib/messaging/protocol';
import {
  CURRENT_DATA_CONSENT_VERSION,
  DEFAULT_SETTINGS,
} from '../lib/settings/schema';

const providerMocks = vi.hoisted(() => ({
  testConnection: vi.fn(),
  complete: vi.fn(),
  listModels: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  cancel: vi.fn(),
  cancelClient: vi.fn(),
}));

const storeMocks = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  loadSecret: vi.fn(),
  restrictLocalStorageToTrustedContexts: vi.fn(),
  watchSettings: vi.fn(),
}));

vi.mock('../lib/checker/service', () => ({
  CheckService: class {
    constructor(_onBusyChange: (busy: boolean) => void) {}
    enqueue(...args: unknown[]) { return serviceMocks.enqueue(...args); }
    cancel(...args: unknown[]) { return serviceMocks.cancel(...args); }
    cancelClient(...args: unknown[]) { return serviceMocks.cancelClient(...args); }
  },
}));

vi.mock('../lib/providers/registry', () => ({
  getProvider: vi.fn(() => providerMocks),
}));

vi.mock('../lib/settings/store', () => storeMocks);

interface Harness {
  contains: ReturnType<typeof vi.fn>;
  openOptionsPage: ReturnType<typeof vi.fn>;
  send(message: unknown): Promise<unknown>;
  connect(port: chrome.runtime.Port): void;
  installed(reason: 'install' | 'update'): void;
}

async function setupBackground(permissionGranted: boolean): Promise<Harness> {
  let backgroundMain: (() => void) | undefined;
  let onConnect: ((port: chrome.runtime.Port) => void) | undefined;
  let onInstalled: ((details: { reason: 'install' | 'update' }) => void) | undefined;
  let onMessage:
    | ((message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => unknown)
    | undefined;

  (globalThis as unknown as { defineBackground: (main: () => void) => unknown }).defineBackground = (main) => {
    backgroundMain = main;
    return main;
  };

  const contains = vi.fn(async () => permissionGranted);
  const openOptionsPage = vi.fn(async () => undefined);
  globalThis.chrome = {
    permissions: { contains },
    storage: {
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
    },
    runtime: {
      id: 'inkwell-test',
      onConnect: { addListener: vi.fn((listener) => { onConnect = listener; }) },
      onInstalled: { addListener: vi.fn((listener) => { onInstalled = listener; }) },
      onMessage: { addListener: vi.fn((listener) => { onMessage = listener; }) },
      getPlatformInfo: vi.fn(async () => ({})),
      openOptionsPage,
    },
    action: {
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      setBadgeTextColor: vi.fn(async () => undefined),
      setBadgeText: vi.fn(async () => undefined),
    },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      query: vi.fn(async () => []),
      sendMessage: vi.fn(async () => undefined),
    },
  } as unknown as typeof chrome;

  await import('../entrypoints/background');
  backgroundMain!();

  return {
    contains,
    openOptionsPage,
    connect: (port) => onConnect!(port),
    installed: (reason) => onInstalled!({ reason }),
    send: (message) => new Promise((resolve) => {
      onMessage!(message, {}, resolve);
    }),
  };
}

function makePort(origin = 'https://writer.example'): {
  port: chrome.runtime.Port;
  emit(message: unknown): void;
  postMessage: ReturnType<typeof vi.fn>;
} {
  let listener: ((message: unknown) => void) | undefined;
  const postMessage = vi.fn();
  const port = {
    name: CHECK_PORT,
    sender: { origin, tab: { id: 4 }, frameId: 0 },
    onMessage: { addListener: vi.fn((next) => { listener = next; }) },
    onDisconnect: { addListener: vi.fn() },
    postMessage,
  } as unknown as chrome.runtime.Port;
  return { port, emit: (message) => listener!(message), postMessage };
}

describe('background provider security', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    storeMocks.loadSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      dataConsentVersion: CURRENT_DATA_CONSENT_VERSION,
      provider: { kind: 'openai', baseUrl: 'https://api.openai.com', model: 'gpt-test' },
      cloudAllowedSites: ['writer.example'],
    });
    storeMocks.loadSecret.mockResolvedValue('top-secret');
    storeMocks.restrictLocalStorageToTrustedContexts.mockResolvedValue(undefined);
    providerMocks.testConnection.mockResolvedValue({ ok: true });
    providerMocks.listModels.mockResolvedValue(['gpt-test']);
    providerMocks.complete.mockResolvedValue({
      text: JSON.stringify({
        issues: [
          { type: 'spelling', original: 'recieve', replacement: 'receive', explanation: 'Misspelling.' },
          { type: 'spelling', original: 'tommorow', replacement: 'tomorrow', explanation: 'Misspelling.' },
        ],
      }),
    });
  });

  it('blocks checks until the exact optional provider origin has been granted', async () => {
    const runtime = await setupBackground(false);
    const testPort = makePort();
    runtime.connect(testPort.port);
    testPort.emit({ t: 'check', requestId: 'request-1', chunkHash: 'hash-1', text: 'Test text.' });

    await vi.waitFor(() => expect(testPort.postMessage).toHaveBeenCalledOnce());
    expect(runtime.contains).toHaveBeenCalledWith({ origins: ['https://api.openai.com/*'] });
    expect(serviceMocks.enqueue).not.toHaveBeenCalled();
    expect(testPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      t: 'error',
      requestId: 'request-1',
      code: 'cors_origin',
      hint: expect.stringMatching(/Settings|grant/i),
    }));
  });

  it('opens privacy setup on first install, but not extension updates', async () => {
    const runtime = await setupBackground(true);

    runtime.installed('update');
    expect(runtime.openOptionsPage).not.toHaveBeenCalled();
    runtime.installed('install');
    expect(runtime.openOptionsPage).toHaveBeenCalledOnce();
  });

  it('rejects field checks until the current privacy disclosure is accepted', async () => {
    storeMocks.loadSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      provider: { kind: 'ollama', baseUrl: 'http://localhost:11434', model: 'test-model' },
    });
    const runtime = await setupBackground(true);
    const testPort = makePort();
    runtime.connect(testPort.port);
    testPort.emit({ t: 'check', requestId: 'request-consent', chunkHash: 'hash', text: 'Private text.' });

    await vi.waitFor(() => expect(testPort.postMessage).toHaveBeenCalledOnce());
    expect(testPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      t: 'error',
      code: 'bad_response',
      hint: expect.stringMatching(/privacy|consent|disclosure/i),
    }));
    expect(serviceMocks.enqueue).not.toHaveBeenCalled();
  });

  it('rejects cloud checks on a web page until that hostname is enabled', async () => {
    storeMocks.loadSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      dataConsentVersion: CURRENT_DATA_CONSENT_VERSION,
      provider: { kind: 'openai', baseUrl: 'https://api.openai.com', model: 'gpt-test' },
      cloudAllowedSites: [],
    });
    const runtime = await setupBackground(true);
    const testPort = makePort('https://writer.example');
    runtime.connect(testPort.port);
    testPort.emit({ t: 'check', requestId: 'request-site', chunkHash: 'hash', text: 'Private text.' });

    await vi.waitFor(() => expect(testPort.postMessage).toHaveBeenCalledOnce());
    expect(testPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      t: 'error',
      code: 'cors_origin',
      hint: expect.stringMatching(/enable.*site|cloud checking/i),
    }));
    expect(runtime.contains).not.toHaveBeenCalled();
    expect(serviceMocks.enqueue).not.toHaveBeenCalled();
  });

  it('also requires per-site consent for a remote custom compatible server', async () => {
    storeMocks.loadSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      dataConsentVersion: CURRENT_DATA_CONSENT_VERSION,
      provider: {
        kind: 'openai-compat',
        baseUrl: 'https://models.example.test/v1',
        model: 'private-model',
      },
      cloudAllowedSites: [],
    });
    const runtime = await setupBackground(true);
    const testPort = makePort('https://writer.example');
    runtime.connect(testPort.port);
    testPort.emit({ t: 'check', requestId: 'request-custom', chunkHash: 'hash', text: 'Private text.' });

    await vi.waitFor(() => expect(testPort.postMessage).toHaveBeenCalledOnce());
    expect(testPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      t: 'error',
      code: 'cors_origin',
      hint: expect.stringMatching(/enable.*site|cloud checking/i),
    }));
    expect(runtime.contains).not.toHaveBeenCalled();
    expect(serviceMocks.enqueue).not.toHaveBeenCalled();
  });

  it('honours the disabled-site list even when the cloud site was previously enabled', async () => {
    storeMocks.loadSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      dataConsentVersion: CURRENT_DATA_CONSENT_VERSION,
      provider: { kind: 'openai', baseUrl: 'https://api.openai.com', model: 'gpt-test' },
      cloudAllowedSites: ['writer.example'],
      disabledSites: ['writer.example'],
    });
    const runtime = await setupBackground(true);
    const testPort = makePort();
    runtime.connect(testPort.port);
    testPort.emit({ t: 'check', requestId: 'request-disabled', chunkHash: 'hash', text: 'Private text.' });

    await vi.waitFor(() => expect(testPort.postMessage).toHaveBeenCalledOnce());
    expect(testPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      t: 'error',
      code: 'cors_origin',
      hint: expect.stringMatching(/disabled/i),
    }));
    expect(serviceMocks.enqueue).not.toHaveBeenCalled();
  });

  it('allows the extension dashboard to check after global consent', async () => {
    const runtime = await setupBackground(true);
    const testPort = makePort('chrome-extension://inkwell-test');
    runtime.connect(testPort.port);
    testPort.emit({ t: 'check', requestId: 'request-dashboard', chunkHash: 'hash', text: 'Private text.' });

    await vi.waitFor(() => expect(serviceMocks.enqueue).toHaveBeenCalledOnce());
    expect(runtime.contains).toHaveBeenCalledWith({ origins: ['https://api.openai.com/*'] });
    expect(testPort.postMessage).not.toHaveBeenCalled();
  });

  it('qualifies the selected model with one structured proofreading completion', async () => {
    const runtime = await setupBackground(true);

    await expect(runtime.send({ t: 'testConnection' })).resolves.toEqual({ ok: true });
    expect(runtime.contains).toHaveBeenCalledWith({ origins: ['https://api.openai.com/*'] });
    expect(providerMocks.testConnection).toHaveBeenCalledOnce();
    expect(providerMocks.complete).toHaveBeenCalledOnce();
    expect(providerMocks.complete.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      apiKey: 'top-secret',
    }));
    expect(providerMocks.complete.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      jsonSchema: expect.any(Object),
    }));
  });

  it('returns an actionable failure when a reachable model cannot proofread with structured JSON', async () => {
    providerMocks.complete.mockResolvedValue({ text: 'Certainly. Here is the corrected sentence.' });
    const runtime = await setupBackground(true);

    const result = await runtime.send({ t: 'testConnection' });
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'bad_response' }));
    expect(result).toEqual(expect.objectContaining({
      hint: expect.stringMatching(/structured JSON|instruct model/i),
    }));
  });

  it('does not list models through an origin Chrome has not authorised', async () => {
    const runtime = await setupBackground(false);

    const result = await runtime.send({ t: 'listModels' });
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'cors_origin' }));
    expect(providerMocks.listModels).not.toHaveBeenCalled();
    expect(storeMocks.loadSecret).not.toHaveBeenCalled();
  });
});
