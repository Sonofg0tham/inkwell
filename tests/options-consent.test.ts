// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CURRENT_DATA_CONSENT_VERSION, DEFAULT_SETTINGS } from '../lib/settings/schema';
import { setupChromeMock } from './helpers/chrome-mock';

async function loadOptions(preconsented = false) {
  const html = fs.readFileSync(path.resolve('entrypoints/options/index.html'), 'utf8');
  document.documentElement.innerHTML = html;
  const chromeMock = setupChromeMock();
  if (preconsented) {
    chromeMock.store.set('settings', {
      ...DEFAULT_SETTINGS,
      dataConsentVersion: CURRENT_DATA_CONSENT_VERSION,
    });
  }
  const request = vi.fn(async () => true);
  (chrome as unknown as { permissions: { request: typeof request } }).permissions = { request };
  const sendMessage = vi.fn(async () => ({ ok: true }));
  chrome.runtime.sendMessage = sendMessage as typeof chrome.runtime.sendMessage;
  await import('../entrypoints/options/main');
  await vi.waitFor(() => {
    expect((document.getElementById('provider') as HTMLSelectElement).value).toBe('ollama');
  });
  return { ...chromeMock, request, sendMessage };
}

function submit(): void {
  document.getElementById('settings-form')?.dispatchEvent(
    new SubmitEvent('submit', { bubbles: true, cancelable: true }),
  );
}

describe('options privacy consent', () => {
  beforeEach(() => {
    vi.resetModules();
    document.documentElement.innerHTML = '';
  });

  it('shows the complete disclosure prominently with an unchecked consent control', async () => {
    await loadOptions();

    const panel = document.getElementById('privacy-consent');
    const copy = panel?.textContent ?? '';
    const checkbox = document.getElementById('data-consent') as HTMLInputElement;

    expect(panel).not.toBeNull();
    expect(copy).toMatch(/form text|user-generated text/i);
    expect(copy).toMatch(/provider you choose|selected provider/i);
    expect(copy).toMatch(/enable.*site|per-site/i);
    expect(copy).toMatch(/workspace documents.*sent|sent.*workspace documents/i);
    expect(copy).toMatch(/documents and settings.*locally|stored locally/i);
    expect(copy).toMatch(/no account/i);
    expect(copy).toMatch(/no telemetry/i);
    expect(copy).toMatch(/no ads/i);
    expect(checkbox.checked).toBe(false);
  });

  it('does not save, request provider access or test while consent is unchecked', async () => {
    const { local, request, sendMessage } = await loadOptions();

    submit();

    await vi.waitFor(() => {
      expect(document.getElementById('save-result')?.textContent).toMatch(/privacy|consent|agree/i);
    });
    expect(local.set).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.getElementById('data-consent'));
  });

  it('persists the current disclosure version only after explicit acceptance', async () => {
    const { store, sendMessage } = await loadOptions();
    const checkbox = document.getElementById('data-consent') as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));

    submit();

    await vi.waitFor(() => {
      expect(document.getElementById('save-result')?.textContent).toMatch(/saved and connected/i);
    });
    expect(store.get('settings')).toEqual(expect.objectContaining({
      dataConsentVersion: CURRENT_DATA_CONSENT_VERSION,
    }));
    expect(sendMessage).toHaveBeenCalledWith({ t: 'testConnection' });
  });

  it('shows an already accepted disclosure as completed on later visits', async () => {
    await loadOptions(true);
    const checkbox = document.getElementById('data-consent') as HTMLInputElement;

    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    expect(document.getElementById('privacy-consent')?.getAttribute('data-state')).toBe('accepted');
  });
});
