import { beforeEach, describe, expect, it, vi } from 'vitest';
import { qualifyProofreadingProvider } from '../lib/providers/qualification';
import type { Provider, ResolvedProviderConfig } from '../lib/providers/types';
import { DEFAULT_SETTINGS, type Settings } from '../lib/settings/schema';

const SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  provider: { kind: 'ollama', baseUrl: 'http://localhost:11434', model: 'test-model' },
};

const CONFIG: ResolvedProviderConfig = { ...SETTINGS.provider };

function provider(): Provider {
  return {
    testConnection: vi.fn(async () => ({ ok: true as const })),
    listModels: vi.fn(async () => ['test-model']),
    complete: vi.fn(async () => ({
      text: JSON.stringify({
        issues: [
          { type: 'spelling', original: 'recieve', replacement: 'receive', explanation: 'Misspelling.' },
          { type: 'spelling', original: 'tommorow', replacement: 'tomorrow', explanation: 'Misspelling.' },
        ],
      }),
    })),
  };
}

describe('provider proofreading qualification', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs a structured completion and accepts anchored proofreading output', async () => {
    const candidate = provider();
    const result = await qualifyProofreadingProvider(candidate, CONFIG, SETTINGS);

    expect(result).toEqual({ ok: true });
    expect(candidate.testConnection).toHaveBeenCalledOnce();
    expect(candidate.complete).toHaveBeenCalledOnce();
    expect(vi.mocked(candidate.complete).mock.calls[0]?.[1].jsonSchema).toBeDefined();
  });

  it('returns the provider connectivity failure without attempting qualification', async () => {
    const candidate = provider();
    vi.mocked(candidate.testConnection).mockResolvedValue({
      ok: false,
      code: 'auth',
      hint: 'The key was rejected.',
    });

    await expect(qualifyProofreadingProvider(candidate, CONFIG, SETTINGS)).resolves.toEqual({
      ok: false,
      code: 'auth',
      hint: 'The key was rejected.',
    });
    expect(candidate.complete).not.toHaveBeenCalled();
  });

  it('rejects a model that does not return JSON with an actionable message', async () => {
    const candidate = provider();
    vi.mocked(candidate.complete).mockResolvedValue({ text: 'I cannot produce JSON.' });

    const result = await qualifyProofreadingProvider(candidate, CONFIG, SETTINGS);
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'bad_response' }));
    expect(result.ok ? '' : result.hint).toMatch(/structured JSON|different instruct model/i);
  });

  it('rejects output that cannot be anchored to the qualification passage', async () => {
    const candidate = provider();
    vi.mocked(candidate.complete).mockResolvedValue({
      text: JSON.stringify({
        issues: [{ type: 'spelling', original: 'not in passage', replacement: 'x', explanation: 'x' }],
      }),
    });

    const result = await qualifyProofreadingProvider(candidate, CONFIG, SETTINGS);
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'bad_response' }));
    expect(result.ok ? '' : result.hint).toMatch(/quote|locate|anchor/i);
  });

  it('rejects valid but ineffective suggestions that miss the known spelling probe', async () => {
    const candidate = provider();
    vi.mocked(candidate.complete).mockResolvedValue({
      text: JSON.stringify({
        issues: [{ type: 'style', original: 'parcel', replacement: 'package', explanation: 'Word choice.' }],
      }),
    });

    const result = await qualifyProofreadingProvider(candidate, CONFIG, SETTINGS);
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'bad_response' }));
    expect(result.ok ? '' : result.hint).toMatch(/obvious spelling|stronger model/i);
  });
});
