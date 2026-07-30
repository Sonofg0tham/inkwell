import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  providerUsesRemoteEndpoint,
  requestProviderOriginPermission,
  validateProviderEndpoint,
} from '../lib/providers/validation';

describe('provider endpoint validation', () => {
  beforeEach(() => {
    globalThis.chrome = {
      permissions: { request: vi.fn(async () => true) },
    } as unknown as typeof chrome;
  });

  it.each([
    ['http://localhost:11434', false],
    ['http://127.0.0.1:1234', false],
  ])('allows the loopback endpoint %s', (baseUrl, requiresPermission) => {
    const endpoint = validateProviderEndpoint('ollama', baseUrl);
    expect(endpoint.baseUrl).toBe(baseUrl);
    expect(endpoint.requiresPermission).toBe(requiresPermission);
  });

  it.each([
    'http://example.com/v1',
    'http://192.168.1.20:11434',
    'http://10.0.0.8:1234',
  ])('rejects plaintext HTTP outside loopback: %s', (baseUrl) => {
    expect(() => validateProviderEndpoint('openai-compat', baseUrl)).toThrow(/HTTPS|loopback/i);
  });

  it.each(['http://127.24.5.9:11434', 'http://[::1]:11434'])(
    'keeps plaintext loopback access to the narrow manifest hosts: %s',
    (baseUrl) => {
      expect(() => validateProviderEndpoint('ollama', baseUrl)).toThrow(/localhost|127\.0\.0\.1|narrow/i);
    },
  );

  it('allows HTTPS custom endpoints but requires their exact origin permission', () => {
    const endpoint = validateProviderEndpoint('openai-compat', 'https://models.example.test/openai');
    expect(endpoint.permissionPattern).toBe('https://models.example.test/*');
    expect(endpoint.requiresPermission).toBe(true);
    expect(endpoint.isBuiltIn).toBe(false);
  });

  it('classifies built-in cloud and remote custom endpoints as remote', () => {
    expect(providerUsesRemoteEndpoint('openai', 'https://api.openai.com')).toBe(true);
    expect(providerUsesRemoteEndpoint('openai-compat', 'https://models.example.test/v1')).toBe(true);
    expect(providerUsesRemoteEndpoint('openai-compat', 'http://localhost:1234')).toBe(false);
    expect(providerUsesRemoteEndpoint('ollama', 'not a URL')).toBe(true);
  });

  it('requires optional permission for built-in cloud endpoints now they are not static', () => {
    const endpoint = validateProviderEndpoint('openai', 'https://api.openai.com');
    expect(endpoint.isBuiltIn).toBe(true);
    expect(endpoint.permissionPattern).toBe('https://api.openai.com/*');
    expect(endpoint.requiresPermission).toBe(true);
  });

  it('rejects unsupported schemes and embedded credentials', () => {
    expect(() => validateProviderEndpoint('ollama', 'file:///tmp/model')).toThrow(/HTTP or HTTPS/i);
    expect(() => validateProviderEndpoint('openai-compat', 'https://user:pass@example.test')).toThrow(/credentials/i);
  });

  it('requests only the exact optional origin and returns a denial', async () => {
    const request = vi.fn(async () => false);
    chrome.permissions.request = request;
    const endpoint = validateProviderEndpoint('openai', 'https://api.openai.com');

    await expect(requestProviderOriginPermission(endpoint)).resolves.toBe(false);
    expect(request).toHaveBeenCalledWith({ origins: ['https://api.openai.com/*'] });
  });
});
