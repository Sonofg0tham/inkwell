export interface SiteHostList {
  hosts: string[];
  invalid: string[];
}

/** Canonical form used by every page-host policy boundary. */
export function canonicaliseSiteHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

/** Compare a runtime hostname with persisted policy entries from any prior version. */
export function siteHostListIncludes(hosts: readonly string[], value: string): boolean {
  const candidate = canonicaliseSiteHost(value);
  return candidate !== '' && hosts.some((host) => canonicaliseSiteHost(host) === candidate);
}

/** Parse user-entered hostnames or URLs into the exact hostname policy uses. */
export function parseSiteHostList(value: string): SiteHostList {
  const hosts = new Set<string>();
  const invalid: string[] = [];

  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(line) ? line : `https://${line}`);
      const host = canonicaliseSiteHost(url.hostname);
      if (
        (url.protocol !== 'http:' && url.protocol !== 'https:') ||
        !host ||
        host.includes('*') ||
        url.username !== '' ||
        url.password !== ''
      ) {
        throw new Error('Unsupported site value');
      }
      hosts.add(host);
    } catch {
      invalid.push(line);
    }
  }

  return { hosts: [...hosts], invalid };
}
