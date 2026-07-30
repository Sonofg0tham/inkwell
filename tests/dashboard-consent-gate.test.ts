// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CURRENT_DATA_CONSENT_VERSION, DEFAULT_SETTINGS } from '../lib/settings/schema';
import { setupChromeMock } from './helpers/chrome-mock';

const documentMocks = vi.hoisted(() => ({
  createDocument: vi.fn(),
  getDocument: vi.fn(),
  updateDocument: vi.fn(),
  moveToTrash: vi.fn(),
  restoreFromTrash: vi.fn(),
  getDocumentsMetadata: vi.fn(),
  deleteDocumentPermanently: vi.fn(),
  getStorageUsage: vi.fn(),
}));

vi.mock('../lib/storage/documents', () => documentMocks);

async function setup(consented: boolean) {
  const html = fs
    .readFileSync(path.resolve('entrypoints/dashboard/index.html'), 'utf8')
    .replace(/<script.*<\/script>/g, '');
  document.body.innerHTML = html;
  const chromeMock = setupChromeMock();
  if (consented) {
    chromeMock.store.set('settings', {
      ...DEFAULT_SETTINGS,
      dataConsentVersion: CURRENT_DATA_CONSENT_VERSION,
    });
  }
  documentMocks.getDocumentsMetadata.mockResolvedValue([]);
  documentMocks.getStorageUsage.mockResolvedValue({ bytes: 0, quota: null });
  const main = await import('../entrypoints/dashboard/main');
  await main.initDashboard();
  return chromeMock;
}

describe('dashboard consent startup gate', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('does not read document storage before consent and routes accessibly to setup', async () => {
    await setup(false);

    const gate = document.getElementById('setup-required') as HTMLElement;
    const shell = document.getElementById('dashboard-shell') as HTMLElement;
    expect(gate.hidden).toBe(false);
    expect(shell.hidden).toBe(true);
    expect(gate.getAttribute('aria-labelledby')).toBe('setup-required-title');
    expect(document.activeElement).toBe(document.getElementById('setup-required-title'));
    expect(documentMocks.getDocumentsMetadata).not.toHaveBeenCalled();
    expect(documentMocks.getDocument).not.toHaveBeenCalled();
    expect(documentMocks.getStorageUsage).not.toHaveBeenCalled();

    (document.getElementById('btn-open-privacy-setup') as HTMLButtonElement).click();
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalledOnce();
  });

  it('starts the workspace only after the current disclosure has been accepted', async () => {
    await setup(true);

    expect((document.getElementById('setup-required') as HTMLElement).hidden).toBe(true);
    expect((document.getElementById('dashboard-shell') as HTMLElement).hidden).toBe(false);
    await vi.waitFor(() => expect(documentMocks.getDocumentsMetadata).toHaveBeenCalled());
  });
});
