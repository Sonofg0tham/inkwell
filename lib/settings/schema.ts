import { z } from 'zod';

export const PROVIDER_KINDS = ['ollama', 'openai-compat', 'openai', 'anthropic'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  ollama: 'Ollama (local)',
  'openai-compat': 'LM Studio / OpenAI-compatible',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

export const DEFAULT_BASE_URLS: Record<ProviderKind, string> = {
  ollama: 'http://localhost:11434',
  'openai-compat': 'http://localhost:1234',
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
};

/** Providers that send text off the user's machine (shows a notice in options). */
export const CLOUD_KINDS: ProviderKind[] = ['openai', 'anthropic'];

export const settingsSchema = z.object({
  enabled: z.boolean().default(true),
  provider: z
    .object({
      kind: z.enum(PROVIDER_KINDS).default('ollama'),
      baseUrl: z.string().default(DEFAULT_BASE_URLS.ollama),
      model: z.string().default('llama3.1:8b'),
    })
    .default({}),
  dialect: z.enum(['en-GB', 'en-US']).default('en-GB'),
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
});

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

/** Normalises a base URL: trims, drops trailing slashes. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}
