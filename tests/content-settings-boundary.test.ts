// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../lib/settings/schema';

const mocks = vi.hoisted(() => ({
  startWatcher: vi.fn(),
  stop: vi.fn(),
  settingsChanged: vi.fn(),
  loadSettings: vi.fn(),
  watchSettings: vi.fn(),
  sendTyped: vi.fn(),
}));

vi.mock('../lib/content/editableWatcher', () => ({
  startWatcher: mocks.startWatcher,
}));

vi.mock('../lib/settings/store', () => ({
  loadSettings: mocks.loadSettings,
  watchSettings: mocks.watchSettings,
}));

vi.mock('../lib/messaging/typed', () => ({
  sendTyped: mocks.sendTyped,
}));

describe('content-script settings boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.startWatcher.mockReturnValue({
      stop: mocks.stop,
      settingsChanged: mocks.settingsChanged,
    });
    mocks.loadSettings.mockResolvedValue(DEFAULT_SETTINGS);
    mocks.sendTyped.mockResolvedValue({
      settings: { ...DEFAULT_SETTINGS, dataConsentVersion: 1 },
      siteHost: 'top.example',
    });
  });

  it('loads sanitised settings from the background and refreshes active controllers on broadcasts', async () => {
    let main: (() => void) | undefined;
    let definition: Record<string, unknown> | undefined;
    let onRuntimeMessage: ((message: unknown) => void) | undefined;
    (globalThis as unknown as { defineContentScript: (config: { main: () => void }) => unknown })
      .defineContentScript = (config) => {
        main = config.main;
        definition = config as unknown as Record<string, unknown>;
        return config;
      };
    globalThis.chrome = {
      runtime: {
        onMessage: {
          addListener: vi.fn((listener: (message: unknown) => void) => {
            onRuntimeMessage = listener;
          }),
        },
      },
    } as unknown as typeof chrome;

    await import('../entrypoints/content');
    expect(definition).toMatchObject({
      allFrames: true,
      matchAboutBlank: true,
      matchOriginAsFallback: true,
    });
    main?.();
    await vi.waitFor(() => expect(mocks.startWatcher).toHaveBeenCalledTimes(1));

    expect(mocks.loadSettings).not.toHaveBeenCalled();
    expect(mocks.watchSettings).not.toHaveBeenCalled();
    expect(mocks.sendTyped).toHaveBeenCalledWith({ t: 'getContentSettings' });
    expect(onRuntimeMessage).toBeTypeOf('function');

    const env = mocks.startWatcher.mock.calls[0]?.[0] as {
      addToDictionary?(word: string): void;
    };
    env.addToDictionary?.('Recieve');
    expect(mocks.sendTyped).toHaveBeenCalledWith({
      t: 'addPersonalDictionaryWord',
      word: 'Recieve',
    });

    onRuntimeMessage?.({
      t: 'contentSettingsChanged',
      settings: { ...DEFAULT_SETTINGS, dataConsentVersion: 1, strictness: 'picky' },
    });
    expect(mocks.settingsChanged).toHaveBeenCalledTimes(1);

    onRuntimeMessage?.({
      t: 'contentSettingsChanged',
      settings: {
        ...DEFAULT_SETTINGS,
        dataConsentVersion: 1,
        provider: { ...DEFAULT_SETTINGS.provider, kind: 'openai' },
        cloudAllowedSites: [],
      },
    });
    expect(mocks.stop).toHaveBeenCalledTimes(1);

    onRuntimeMessage?.({
      t: 'contentSettingsChanged',
      settings: {
        ...DEFAULT_SETTINGS,
        dataConsentVersion: 1,
        provider: { ...DEFAULT_SETTINGS.provider, kind: 'openai' },
        cloudAllowedSites: ['top.example'],
      },
    });
    expect(mocks.startWatcher).toHaveBeenCalledTimes(2);

    onRuntimeMessage?.({
      t: 'contentSettingsChanged',
      settings: {
        ...DEFAULT_SETTINGS,
        dataConsentVersion: 1,
        provider: {
          kind: 'openai-compat',
          baseUrl: 'https://models.example.test/v1',
          model: 'private-model',
        },
        cloudAllowedSites: [],
      },
    });
    expect(mocks.stop).toHaveBeenCalledTimes(2);
  });

  it('keeps checking off when a stored block entry is an equivalent FQDN spelling', async () => {
    let main: (() => void) | undefined;
    (globalThis as unknown as { defineContentScript: (config: { main: () => void }) => unknown })
      .defineContentScript = (config) => {
        main = config.main;
        return config;
      };
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener: vi.fn() },
      },
    } as unknown as typeof chrome;
    mocks.sendTyped.mockResolvedValue({
      settings: {
        ...DEFAULT_SETTINGS,
        dataConsentVersion: 1,
        disabledSites: ['TOP.EXAMPLE.'],
      },
      siteHost: 'top.example',
    });

    await import('../entrypoints/content');
    main?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.startWatcher).not.toHaveBeenCalled();
  });
});
