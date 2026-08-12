import { describe, expect, it } from 'vitest';
import config from '../wxt.config';

describe('manifest provider permissions', () => {
  it('keeps cloud provider origins optional until the user selects one', () => {
    const manifest = config.manifest as Record<string, unknown>;
    const required = manifest.host_permissions as string[];
    const optional = manifest.optional_host_permissions as string[];

    expect(required).toEqual(['http://localhost/*', 'http://127.0.0.1/*']);
    expect(required).not.toContain('https://api.openai.com/*');
    expect(required).not.toContain('https://api.anthropic.com/*');
    expect(required).not.toContain('https://openrouter.ai/*');
    expect(required).not.toContain('https://generativelanguage.googleapis.com/*');
    expect(optional).toEqual(['https://*/*']);
  });

  it('requires the Chromium storage APIs used to isolate secrets and frame state', () => {
    const manifest = config.manifest as Record<string, unknown>;
    expect(manifest.minimum_chrome_version).toBe('119');
  });
});
