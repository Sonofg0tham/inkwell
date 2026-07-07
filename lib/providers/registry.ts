import type { ProviderKind } from '../settings/schema';
import { anthropicProvider } from './anthropic';
import { lmStudioProvider, openaiProvider } from './openaiCompat';
import { ollamaProvider } from './ollama';
import type { Provider } from './types';

const providers: Record<ProviderKind, Provider> = {
  ollama: ollamaProvider,
  'openai-compat': lmStudioProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
};

export function getProvider(kind: ProviderKind): Provider {
  return providers[kind];
}
