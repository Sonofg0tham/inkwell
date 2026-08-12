import { describe, expect, it } from 'vitest';
import { parseSiteHostList } from '../lib/settings/sites';

describe('site blocklist parsing', () => {
  it('normalises hostnames and full URLs to the exact hostname used by content policy', () => {
    expect(
      parseSiteHostList(`
        Example.COM.
        https://mail.example.com./inbox
        example.com/path
        https://EXAMPLE.com:8443/private
      `),
    ).toEqual({
      hosts: ['example.com', 'mail.example.com'],
      invalid: [],
    });
  });

  it('rejects values that cannot be enforced as an exact web hostname', () => {
    expect(parseSiteHostList('not a host\nftp://example.com\n*.example.com')).toEqual({
      hosts: [],
      invalid: ['not a host', 'ftp://example.com', '*.example.com'],
    });
  });
});
