// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CURRENT_DATA_CONSENT_VERSION,
  DEFAULT_SETTINGS,
  type Settings,
} from '../lib/settings/schema';
import { setupChromeMock } from './helpers/chrome-mock';

async function loadOptions(overrides: Partial<Settings> = {}) {
  const html = fs.readFileSync(path.resolve('entrypoints/options/index.html'), 'utf8');
  document.documentElement.innerHTML = html;
  const chromeMock = setupChromeMock();
  chromeMock.store.set('settings', {
    ...DEFAULT_SETTINGS,
    dataConsentVersion: CURRENT_DATA_CONSENT_VERSION,
    ...overrides,
  });
  (chrome as unknown as { permissions: { request: () => Promise<boolean> } }).permissions = {
    request: vi.fn(async () => true),
  };
  chrome.runtime.sendMessage = vi.fn(async () => ({ ok: true })) as typeof chrome.runtime.sendMessage;
  await import('../entrypoints/options/main');
  await vi.waitFor(() => {
    expect((document.getElementById('provider') as HTMLSelectElement).value).toBe('ollama');
  });
  return chromeMock;
}

function submit(): void {
  document.getElementById('settings-form')?.dispatchEvent(
    new SubmitEvent('submit', { bubbles: true, cancelable: true }),
  );
}

describe('options language and personal dictionary', () => {
  beforeEach(() => {
    vi.resetModules();
    document.documentElement.innerHTML = '';
  });

  it('offers and persists all five supported English dialects', async () => {
    const { store } = await loadOptions();
    const dialects = [...document.querySelectorAll<HTMLInputElement>('input[name="dialect"]')]
      .map((input) => input.value);
    expect(dialects).toEqual(['en-GB', 'en-US', 'en-CA', 'en-AU', 'en-IN']);

    const australian = document.querySelector<HTMLInputElement>('input[value="en-AU"]')!;
    australian.checked = true;
    submit();

    await vi.waitFor(() => {
      expect((store.get('settings') as Settings).dialect).toBe('en-AU');
    });
  });

  it('shows saved words and supports adding, removing and clearing them', async () => {
    const { store } = await loadOptions({ personalDictionary: ['Inkwell'] });
    expect(document.getElementById('dictionary-list')?.textContent).toContain('Inkwell');

    const input = document.getElementById('dictionary-word') as HTMLInputElement;
    input.value = 'Colourise';
    document.getElementById('dictionary-add')?.click();
    await vi.waitFor(() => {
      expect((store.get('settings') as Settings).personalDictionary).toEqual(['Inkwell', 'Colourise']);
    });

    const remove = [...document.querySelectorAll<HTMLButtonElement>('[data-remove-word]')]
      .find((button) => button.dataset.removeWord === 'Inkwell');
    remove?.click();
    await vi.waitFor(() => {
      expect((store.get('settings') as Settings).personalDictionary).toEqual(['Colourise']);
    });

    document.getElementById('dictionary-clear')?.click();
    await vi.waitFor(() => {
      expect((store.get('settings') as Settings).personalDictionary).toEqual([]);
    });
  });

  it('explains rejected dictionary entries without saving them', async () => {
    const { local, store } = await loadOptions({ personalDictionary: [] });
    local.set.mockClear();
    const input = document.getElementById('dictionary-word') as HTMLInputElement;
    input.value = 'two words';

    document.getElementById('dictionary-add')?.click();

    await vi.waitFor(() => {
      expect(document.getElementById('dictionary-status')?.textContent).toMatch(/single word/i);
    });
    expect((store.get('settings') as Settings).personalDictionary).toEqual([]);
    expect(local.set).not.toHaveBeenCalled();
  });
});
