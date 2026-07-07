import { DEFAULT_SETTINGS, settingsSchema, type ProviderKind, type Settings } from './schema';

const SETTINGS_KEY = 'settings';
// Secrets live under a dedicated storage key, separate from settings, so the
// settings object can be passed around and logged (redacted) without ever
// touching a key. storage.local only — never storage.sync.
const SECRETS_KEY = 'secrets';

export async function loadSettings(): Promise<Settings> {
  const raw = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  const parsed = settingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export function watchSettings(cb: (settings: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SETTINGS_KEY]) return;
    const parsed = settingsSchema.safeParse(changes[SETTINGS_KEY].newValue ?? {});
    cb(parsed.success ? parsed.data : DEFAULT_SETTINGS);
  });
}

type SecretMap = Partial<Record<ProviderKind, string>>;

/**
 * Reads an API key. Only callable from the background service worker — the key
 * must never be handled in a page or content-script context.
 */
export async function loadSecret(kind: ProviderKind): Promise<string | undefined> {
  if (typeof window !== 'undefined') {
    throw new Error('loadSecret must only be called from the background service worker');
  }
  const secrets = ((await chrome.storage.local.get(SECRETS_KEY))[SECRETS_KEY] ?? {}) as SecretMap;
  return secrets[kind] || undefined;
}

/** Writes (or clears, with null) an API key. Called from the options page save flow. */
export async function saveSecret(kind: ProviderKind, key: string | null): Promise<void> {
  const secrets = ((await chrome.storage.local.get(SECRETS_KEY))[SECRETS_KEY] ?? {}) as SecretMap;
  if (key) secrets[kind] = key;
  else delete secrets[kind];
  await chrome.storage.local.set({ [SECRETS_KEY]: secrets });
}

/** Whether a key is stored for this provider — safe to call from any context. */
export async function hasSecret(kind: ProviderKind): Promise<boolean> {
  const secrets = ((await chrome.storage.local.get(SECRETS_KEY))[SECRETS_KEY] ?? {}) as SecretMap;
  return Boolean(secrets[kind]);
}

/** The only sanctioned way to log provider config — never logs the key. */
export function redactCfg(cfg: { kind: string; baseUrl: string; model: string }): string {
  return `${cfg.kind} · ${cfg.model} @ ${cfg.baseUrl}`;
}
