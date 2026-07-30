import { z } from 'zod';

export const PROVIDER_KINDS = [
  'ollama',
  'openai-compat',
  'openrouter',
  'gemini',
  'openai',
  'anthropic',
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  ollama: 'Ollama (local)',
  'openai-compat': 'LM Studio / OpenAI-compatible',
  openrouter: 'OpenRouter',
  gemini: 'Google Gemini',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

export const DEFAULT_BASE_URLS: Record<ProviderKind, string> = {
  ollama: 'http://localhost:11434',
  'openai-compat': 'http://localhost:1234',
  openrouter: 'https://openrouter.ai/api',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
};

/** Sensible starting model per provider — users can pick another any time. */
export const DEFAULT_MODELS: Record<ProviderKind, string> = {
  ollama: 'qwen2.5:7b-instruct',
  'openai-compat': 'qwen2.5:7b-instruct',
  openrouter: 'openai/gpt-5-mini',
  // flash-lite: the free tier allows more requests per minute, which suits a
  // check-on-every-pause grammar assistant far better than full flash.
  gemini: 'gemini-3.5-flash-lite',
  openai: 'gpt-5-mini',
  anthropic: 'claude-haiku-4-5-20251001',
};

/** Where to create an API key, shown next to the key field. */
export const KEY_HELP_URLS: Partial<Record<ProviderKind, string>> = {
  openrouter: 'https://openrouter.ai/keys',
  gemini: 'https://aistudio.google.com/apikey',
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
};

/** Providers that send text off the user's machine (shows a notice in options). */
export const CLOUD_KINDS: ProviderKind[] = ['openrouter', 'gemini', 'openai', 'anthropic'];
export const CURRENT_DATA_CONSENT_VERSION = 1;
export const DIALECTS = ['en-GB', 'en-US', 'en-CA', 'en-AU', 'en-IN'] as const;

export const settingsSchema = z.object({
  enabled: z.boolean().default(true),
  dataConsentVersion: z
    .number()
    .int()
    .min(0)
    .max(CURRENT_DATA_CONSENT_VERSION)
    .default(0),
  provider: z
    .object({
      kind: z.enum(PROVIDER_KINDS).default('ollama'),
      baseUrl: z.string().default(DEFAULT_BASE_URLS.ollama),
      model: z.string().default(DEFAULT_MODELS.ollama),
    })
    .default({}),
  dialect: z.enum(DIALECTS).default('en-GB'),
  formality: z.enum(['neutral', 'formal', 'casual']).default('neutral'),
  strictness: z.enum(['standard', 'picky']).default('standard'),
  categories: z
    .object({
      spelling: z.boolean().default(true),
      grammar: z.boolean().default(true),
      punctuation: z.boolean().default(true),
      style: z.boolean().default(true),
    })
    .default({}),
  disabledSites: z.array(z.string()).default([]),
  cloudAllowedSites: z.array(z.string()).default([]),
  personalDictionary: z
    .array(z.string().trim().min(1).max(80))
    .max(1_000)
    .default([]),
});

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

/** Normalises a base URL: trims, drops trailing slashes. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}
