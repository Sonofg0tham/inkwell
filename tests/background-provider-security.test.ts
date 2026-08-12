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

function makePort(origin = 'https://writer.example', topUrl = origin): {
  port: chrome.runtime.Port;
  emit(message: unknown): void;
  postMessage: ReturnType<typeof vi.fn>;
} {
  let listener: ((message: unknown) => void) | undefined;
  const postMessage = vi.fn();
  const port = {
    name: CHECK_PORT,
    sender: { origin, tab: { id: 4, url: topUrl }, frameId: 0 },
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
    providerMocks.complete.mockImplementation(async (_config, request) => {
      const prompt = request.messages.map((message: { content: string }) => message.content).join('\n');
      const issues = prompt.includes('I will recieve the parcel today. She walk to work every day.')
        ? [
            { type: 'spelling', original: 'recieve', replacement: 'receive', explanation: 'Misspelling.' },
            { type: 'grammar', original: 'She walk', replacement: 'She walks', explanation: 'Agreement.' },
          ]
        : prompt.includes('This sentence has an obvious punctuation error! !')
          ? [{ type: 'punctuation', original: '! !', replacement: '!', explanation: 'Duplicate punctuation.' }]
          : prompt.includes('Due to the fact that it was raining, we stayed inside.')
            ? [{ type: 'style', original: 'Due to the fact that', replacement: 'Because', explanation: 'Use a concise conjunction.' }]
            : [];
      return { text: JSON.stringify({ issues }) };
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

  it('blocks a dotted top-level FQDN when the stored hostname is an equivalent spelling', async () => {
    storeMocks.loadSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      dataConsentVersion: CURRENT_DATA_CONSENT_VERSION,
      provider: { kind: 'ollama', baseUrl: 'http://localhost:11434', model: 'test-model' },
      disabledSites: ['WRITER.EXAMPLE.'],
    });
    const runtime = await setupBackground(true);
    const testPort = makePort(
      'https://editor-widget.example',
      'https://Writer.Example./document/1',
    );
    runtime.connect(testPort.port);
    testPort.emit({
      t: 'check',
      requestId: 'request-dotted-fqdn',
      chunkHash: 'hash',
      text: 'Private text.',
    });

    await vi.waitFor(() => {
      expect(testPort.postMessage.mock.calls.length + serviceMocks.enqueue.mock.calls.length).toBe(1);
    });
    expect(testPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      t: 'error',
      requestId: 'request-dotted-fqdn',
      code: 'cors_origin',
      hint: expect.stringMatching(/disabled.*writer\.example/i),
    }));
    expect(serviceMocks.enqueue).not.toHaveBeenCalled();
  });

  it('returns a canonical popup hostname and applies an equivalent stored block entry', async () => {
    storeMocks.loadSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      dataConsentVersion: CURRENT_DATA_CONSENT_VERSION,
      disabledSites: ['WRITER.EXAMPLE.'],
    });
    const runtime = await setupBackground(true);
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 4, url: 'https://Writer.Example./document/1' } as chrome.tabs.Tab,
    ]);

    const state = await runtime.send({ t: 'getTabState' });

    expect(state).toEqual(expect.objectContaining({
      host: 'writer.example',
      siteDisabled: true,
    }));
  });

  it('uses the top-level site consent for a cross-origin cloud editor frame', async () => {
    const runtime = await setupBackground(true);
    const testPort = makePort(
      'https://editor-widget.example',
      'https://writer.example/document/1',
    );
    runtime.connect(testPort.port);
    testPort.emit({ t: 'check', requestId: 'request-frame', chunkHash: 'hash', text: 'Private text.' });

    await vi.waitFor(() => expect(serviceMocks.enqueue).toHaveBeenCalledOnce());
    expect(testPort.postMessage).not.toHaveBeenCalled();
  });

  it('disables every child frame when the top-level site is disabled', async () => {
    storeMocks.loadSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      dataConsentVersion: CURRENT_DATA_CONSENT_VERSION,
      provider: { kind: 'ollama', baseUrl: 'http://localhost:11434', model: 'test-model' },
      disabledSites: ['writer.example'],
    });
    const runtime = await setupBackground(true);
    const testPort = makePort(
      'https://editor-widget.example',
      'https://writer.example/document/1',
    );
    runtime.connect(testPort.port);
    testPort.emit({ t: 'check', requestId: 'request-disabled-frame', chunkHash: 'hash', text: 'Private text.' });

    await vi.waitFor(() => expect(testPort.postMessage).toHaveBeenCalledOnce());
    expect(testPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      t: 'error',
      requestId: 'request-disabled-frame',
      code: 'cors_origin',
      hint: expect.stringMatching(/disabled.*writer\.example/i),
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

  it('qualifies the selected model with the structured proofreading corpus', async () => {
    const runtime = await setupBackground(true);

    await expect(runtime.send({ t: 'testConnection' })).resolves.toEqual({ ok: true });
    expect(runtime.contains).toHaveBeenCalledWith({ origins: ['https://api.openai.com/*'] });
    expect(providerMocks.testConnection).toHaveBeenCalledOnce();
    expect(providerMocks.complete).toHaveBeenCalledTimes(4);
    for (const [config, request] of providerMocks.complete.mock.calls) {
      expect(config).toEqual(expect.objectContaining({ apiKey: 'top-secret' }));
      expect(request).toEqual(expect.objectContaining({ jsonSchema: expect.any(Object) }));
    }
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
