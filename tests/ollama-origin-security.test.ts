import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProvider } from '../lib/providers/registry';

describe('Ollama origin guidance', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names this extension origin and never recommends a wildcard after a 403', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        getURL: () => 'chrome-extension://inkwell-test/',
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })));

    const result = await getProvider('ollama').testConnection({
      kind: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1:8b',
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'cors_origin' }));
    expect(result.ok ? '' : result.hint).toContain(
      'OLLAMA_ORIGINS=chrome-extension://inkwell-test',
    );
    expect(result.ok ? '' : result.hint).not.toContain('*');
  });
});
