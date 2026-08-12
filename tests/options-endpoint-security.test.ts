// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setupChromeMock } from './helpers/chrome-mock';
import {
  CURRENT_DATA_CONSENT_VERSION,
  DEFAULT_BASE_URLS,
  DEFAULT_SETTINGS,
  type Settings,
} from '../lib/settings/schema';

async function loadOptions(permissionGranted: boolean, initialSettings?: Settings) {
  const html = fs.readFileSync(path.resolve('entrypoints/options/index.html'), 'utf8');
  document.documentElement.innerHTML = html;
  const chromeMock = setupChromeMock();
  if (initialSettings) chromeMock.store.set('settings', initialSettings);
  const request = vi.fn(async () => permissionGranted);
  (chrome as unknown as { permissions: { request: typeof request } }).permissions = { request };
  chrome.runtime.sendMessage = vi.fn(async (message: unknown) =>
    (message as { t?: string })?.t === 'testConnection'
      ? { ok: true }
      : { ok: true, models: [] },
  ) as typeof chrome.runtime.sendMessage;
  await import('../entrypoints/options/main');
  await vi.waitFor(() => expect((document.getElementById('provider') as HTMLSelectElement).value)
    .toBe(initialSettings?.provider.kind ?? 'ollama'));
  const consent = document.getElementById('data-consent') as HTMLInputElement;
  consent.checked = true;
  consent.dispatchEvent(new Event('change', { bubbles: true }));
  return { ...chromeMock, request };
}

function submit(): void {
  document.getElementById('settings-form')?.dispatchEvent(
    new SubmitEvent('submit', { bubbles: true, cancelable: true }),
  );
}

describe('options endpoint security', () => {
  beforeEach(() => {
    vi.resetModules();
    document.documentElement.innerHTML = '';
  });

  it.each(['openrouter', 'gemini', 'openai', 'anthropic'])(
    'locks the official %s server address and directs custom servers to OpenAI-compatible',
    async (kind) => {
      await loadOptions(true);
      const provider = document.getElementById('provider') as HTMLSelectElement;
      const baseUrl = document.getElementById('base-url') as HTMLInputElement;
      const hint = document.getElementById('base-url-hint');

      provider.value = kind;
      provider.dispatchEvent(new Event('change', { bubbles: true }));

      expect(baseUrl.readOnly).toBe(true);
      expect(hint?.textContent).toMatch(/official API address is fixed/i);
      expect(hint?.textContent).toMatch(/LM Studio \/ OpenAI-compatible/i);
    },
  );

  it.each(['ollama', 'openai-compat'])(
    'makes the server address editable again for %s',
    async (kind) => {
      await loadOptions(true);
      const provider = document.getElementById('provider') as HTMLSelectElement;
      const baseUrl = document.getElementById('base-url') as HTMLInputElement;

      provider.value = 'openai';
      provider.dispatchEvent(new Event('change', { bubbles: true }));
      expect(baseUrl.readOnly).toBe(true);

      provider.value = kind;
      provider.dispatchEvent(new Event('change', { bubbles: true }));

      expect(baseUrl.readOnly).toBe(false);
    },
  );

  it('normalises a legacy custom cloud address instead of locking it into the read-only field', async () => {
    await loadOptions(true, {
      ...DEFAULT_SETTINGS,
      dataConsentVersion: CURRENT_DATA_CONSENT_VERSION,
      provider: {
        kind: 'openai',
        baseUrl: 'https://legacy-proxy.example/v1',
        model: 'gpt-test',
      },
    });

    const baseUrl = document.getElementById('base-url') as HTMLInputElement;
    expect(baseUrl.readOnly).toBe(true);
    expect(baseUrl.value).toBe(DEFAULT_BASE_URLS.openai);
  });

  it('blocks plaintext remote model servers before requesting permission or saving', async () => {
    const { local, request } = await loadOptions(true);
    const provider = document.getElementById('provider') as HTMLSelectElement;
    provider.value = 'openai-compat';
    provider.dispatchEvent(new Event('change', { bubbles: true }));
    (document.getElementById('base-url') as HTMLInputElement).value = 'http://192.168.1.20:1234';

    submit();
    await vi.waitFor(() => {
      expect(document.getElementById('save-result')?.textContent).toMatch(/HTTPS|loopback/i);
    });
    expect(request).not.toHaveBeenCalled();
    expect(local.set).not.toHaveBeenCalled();
  });

  it('surfaces exact cloud-origin permission denial and saves nothing', async () => {
    const { local, request } = await loadOptions(false);
    const provider = document.getElementById('provider') as HTMLSelectElement;
    provider.value = 'openai';
    provider.dispatchEvent(new Event('change', { bubbles: true }));

    submit();
    await vi.waitFor(() => {
      expect(document.getElementById('save-result')?.textContent).toContain('Permission for https://api.openai.com was declined');
    });
    expect(request).toHaveBeenCalledWith({ origins: ['https://api.openai.com/*'] });
    expect(local.set).not.toHaveBeenCalled();
  });

  it('saves and qualifies a built-in cloud provider after the exact grant succeeds', async () => {
    const { store, request } = await loadOptions(true);
    const provider = document.getElementById('provider') as HTMLSelectElement;
    provider.value = 'openai';
    provider.dispatchEvent(new Event('change', { bubbles: true }));

    submit();
    await vi.waitFor(() => {
      expect(document.getElementById('save-result')?.textContent).toBe('Saved and connected. You’re all set.');
    });
    expect(request).toHaveBeenCalledWith({ origins: ['https://api.openai.com/*'] });
    expect(store.get('settings')?.provider).toEqual(expect.objectContaining({
      kind: 'openai',
      baseUrl: 'https://api.openai.com',
    }));
  });
});
