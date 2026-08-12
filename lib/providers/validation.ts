import { CLOUD_KINDS, DEFAULT_BASE_URLS, type ProviderKind } from '../settings/schema';

export interface ValidatedProviderEndpoint {
  baseUrl: string;
  origin: string;
  permissionPattern: string | null;
  requiresPermission: boolean;
  isBuiltIn: boolean;
  isLoopback: boolean;
}

export class ProviderEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderEndpointError';
  }
}

function canonicalBaseUrl(url: URL): string {
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path === '' || path === '/' ? '' : path}`;
}

function canonicalDefault(kind: ProviderKind): string {
  return canonicalBaseUrl(new URL(DEFAULT_BASE_URLS[kind]));
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  const octets = host.split('.');
  if (octets.length !== 4 || octets[0] !== '127') return false;
  return octets.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

/**
 * Validates the model server before it reaches storage or fetch. Plaintext is
 * limited to the machine's loopback interface; every other server needs TLS.
 */
export function validateProviderEndpoint(
  kind: ProviderKind,
  rawBaseUrl: string,
): ValidatedProviderEndpoint {
  let url: URL;
  try {
    url = new URL(rawBaseUrl.trim() || DEFAULT_BASE_URLS[kind]);
  } catch {
    throw new ProviderEndpointError('That server address is not a valid URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderEndpointError('The server address must use HTTP or HTTPS.');
  }
  if (url.username || url.password) {
    throw new ProviderEndpointError('Do not put credentials in the server address. Use the API key field.');
  }
  if (url.search || url.hash) {
    throw new ProviderEndpointError('The server address must not contain a query string or fragment.');
  }

  const baseUrl = canonicalBaseUrl(url);
  if (CLOUD_KINDS.includes(kind) && baseUrl !== canonicalDefault(kind)) {
    throw new ProviderEndpointError(
      'Built-in cloud providers are locked to their official endpoint. Choose LM Studio / OpenAI-compatible for a custom server.',
    );
  }

  const isLoopback = isLoopbackHostname(url.hostname);
  if (url.protocol === 'http:' && !isLoopback) {
    throw new ProviderEndpointError(
      'Plaintext HTTP is allowed only for loopback servers such as localhost, 127.x.x.x or ::1. Use HTTPS for every other server.',
    );
  }
  const isSupportedPlaintextLoopback =
    url.hostname.toLowerCase() === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol === 'http:' && !isSupportedPlaintextLoopback) {
    throw new ProviderEndpointError(
      'Plaintext local servers must use localhost or 127.0.0.1 so Inkwell can keep its HTTP access narrowly scoped.',
    );
  }

  // These are the only provider origins retained as required manifest access.
  // Other loopback forms are safe to use, but still need their exact runtime
  // grant because Chrome match patterns do not cover them implicitly.
  const staticallyAllowed = url.protocol === 'http:' && isSupportedPlaintextLoopback;
  const permissionPattern = staticallyAllowed ? null : `${url.origin}/*`;

  return {
    baseUrl,
    origin: url.origin,
    permissionPattern,
    requiresPermission: permissionPattern !== null,
    isBuiltIn: baseUrl === canonicalDefault(kind),
    isLoopback,
  };
}

/** True when checks leave the user's machine. Invalid stored endpoints fail
 * closed as remote until the user corrects them in Settings. */
export function providerUsesRemoteEndpoint(
  kind: ProviderKind,
  rawBaseUrl: string,
): boolean {
  if (CLOUD_KINDS.includes(kind)) return true;
  try {
    return !validateProviderEndpoint(kind, rawBaseUrl).isLoopback;
  } catch {
    return true;
  }
}

/** Must be called directly from the options-page user gesture. */
export async function requestProviderOriginPermission(
  endpoint: ValidatedProviderEndpoint,
): Promise<boolean> {
  if (!endpoint.permissionPattern) return true;
  try {
    return await chrome.permissions.request({ origins: [endpoint.permissionPattern] });
  } catch {
    return false;
  }
}

/** Background-side guard. It never requests new authority without a user click. */
export async function hasProviderOriginPermission(
  endpoint: ValidatedProviderEndpoint,
): Promise<boolean> {
  if (!endpoint.permissionPattern) return true;
  try {
    return await chrome.permissions.contains({ origins: [endpoint.permissionPattern] });
  } catch {
    return false;
  }
}

export function missingProviderPermissionHint(endpoint: ValidatedProviderEndpoint): string {
  return `Permission for ${endpoint.origin} is missing. Open Inkwell Settings and save this provider again to grant the exact origin.`;
}
