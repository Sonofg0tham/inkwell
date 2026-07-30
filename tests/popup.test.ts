// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { setupChromeMock } from './helpers/chrome-mock';
import { DEFAULT_SETTINGS } from '../lib/settings/schema';

const chromeMock = setupChromeMock();

describe('popup workspace navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    const htmlPath = path.resolve(__dirname, '../entrypoints/popup/index.html');
    document.body.innerHTML = fs.readFileSync(htmlPath, 'utf8').replace(/<script.*<\/script>/g, '');
  });

  it('opens the workspace when the primary popup action is clicked', async () => {
    await import('../entrypoints/popup/main');

    const workspaceButton = document.getElementById('open-workspace') as HTMLButtonElement | null;
    expect(workspaceButton).not.toBeNull();

    workspaceButton?.click();

    expect(chromeMock).toBeDefined();
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: chrome.runtime.getURL('dashboard.html'),
    });
  });

  it('persists a quick spelling toggle and dialect choice', async () => {
    await import('../entrypoints/popup/main');
    await Promise.resolve();

    const spelling = document.getElementById('quick-cat-spelling') as HTMLInputElement | null;
    const dialect = document.getElementById('quick-dialect') as HTMLSelectElement | null;
    expect(spelling).not.toBeNull();
    expect(dialect).not.toBeNull();

    if (spelling) {
      spelling.checked = false;
      spelling.dispatchEvent(new Event('change'));
    }
    if (dialect) {
      dialect.value = 'en-US';
      dialect.dispatchEvent(new Event('change'));
    }
    await Promise.resolve();
    await Promise.resolve();

    const savedSettings = (await chrome.storage.local.get('settings')).settings;
    expect(savedSettings.categories.spelling).toBe(false);
    expect(savedSettings.dialect).toBe('en-US');
  });

  it('does not describe a failed page check as clean writing', async () => {
    await chrome.storage.local.set({
      settings: { ...DEFAULT_SETTINGS, dataConsentVersion: 1 },
    });
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      enabled: true,
      host: 'example.test',
      siteDisabled: false,
      issueCount: 0,
      checkPhase: 'error',
      checkHint: 'Could not reach the local model.',
    });

    await import('../entrypoints/popup/main');
    await vi.waitFor(() => {
      expect(document.getElementById('issue-line')?.hidden).toBe(false);
    });

    expect(document.getElementById('issue-line')?.textContent).toContain('Checker unavailable');
    expect(document.getElementById('issue-line')?.textContent).not.toContain('No suggestions');
  });

  it('prompts for privacy setup before claiming that checking is active', async () => {
    await chrome.storage.local.remove('settings');
    await import('../entrypoints/popup/main');
    await vi.waitFor(() => expect(document.getElementById('issue-line')?.hidden).toBe(false));

    expect(document.getElementById('issue-line')?.textContent).toContain('privacy setup');
    expect((document.getElementById('toggle-global') as HTMLInputElement).checked).toBe(false);
  });

  it('uses the site toggle as explicit cloud-provider consent', async () => {
    await chrome.storage.local.set({
      settings: {
        ...DEFAULT_SETTINGS,
        dataConsentVersion: 1,
        provider: { ...DEFAULT_SETTINGS.provider, kind: 'openai' },
        cloudAllowedSites: [],
      },
    });
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      enabled: true,
      host: 'example.test',
      siteDisabled: true,
      issueCount: 0,
      checkPhase: 'idle',
    });

    await import('../entrypoints/popup/main');
    await vi.waitFor(() => expect(document.getElementById('site-row')?.hidden).toBe(false));
    const toggle = document.getElementById('toggle-site') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await vi.waitFor(async () => {
      const saved = (await chrome.storage.local.get('settings')).settings;
      expect(saved.cloudAllowedSites).toContain('example.test');
    });
  });

  it('uses the same site consent for a remote custom compatible server', async () => {
    await chrome.storage.local.set({
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
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      enabled: true,
      host: 'example.test',
      siteDisabled: true,
      issueCount: 0,
      checkPhase: 'idle',
    });

    await import('../entrypoints/popup/main');
    await vi.waitFor(() => expect(document.getElementById('site-row')?.hidden).toBe(false));
    const toggle = document.getElementById('toggle-site') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await vi.waitFor(async () => {
      const saved = (await chrome.storage.local.get('settings')).settings;
      expect(saved.cloudAllowedSites).toContain('example.test');
    });
  });
});
