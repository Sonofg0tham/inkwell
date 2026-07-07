// End-to-end pipeline test against a real local Ollama: prompt building →
// /api/chat → JSON extraction → anchor matching. Skips itself when Ollama
// isn't running, so `npm test` stays green on machines without it.
import { describe, expect, it } from 'vitest';
import { locateIssues } from '../lib/checker/anchor';
import { buildMessages } from '../lib/checker/prompt';
import { ISSUE_JSON_SCHEMA, parseIssues } from '../lib/checker/schema';
import { ollamaProvider } from '../lib/providers/ollama';
import { DEFAULT_SETTINGS } from '../lib/settings/schema';

const BASE_URL = 'http://localhost:11434';

async function firstModel(): Promise<string | null> {
  try {
    const models = await ollamaProvider.listModels({
      kind: 'ollama',
      baseUrl: BASE_URL,
      model: '',
    });
    return models[0] ?? null;
  } catch {
    return null;
  }
}

const model = await firstModel();

describe.skipIf(model === null)('Ollama end-to-end', () => {
  it(
    'finds and anchors real issues in a faulty sentence',
    { timeout: 120_000 },
    async () => {
      const text = 'Their going to recieve the package tommorow, I beleive.';
      const { text: response } = await ollamaProvider.complete(
        { kind: 'ollama', baseUrl: BASE_URL, model: model! },
        {
          messages: buildMessages(DEFAULT_SETTINGS, text),
          temperature: 0,
          maxTokens: 2048,
          jsonSchema: ISSUE_JSON_SCHEMA,
          signal: new AbortController().signal,
        },
      );
      const raw = parseIssues(response);
      const located = locateIssues(text, raw, DEFAULT_SETTINGS.categories);

      // The model must find at least a couple of the four planted errors, and
      // every located issue must anchor to text that genuinely exists.
      expect(raw.length).toBeGreaterThanOrEqual(2);
      expect(located.length).toBeGreaterThanOrEqual(1);
      for (const issue of located) {
        expect(text.slice(issue.start, issue.end)).toBe(issue.original);
      }
      // eslint-disable-next-line no-console
      console.log(
        `model ${model}: ${raw.length} raw, ${located.length} anchored →`,
        located.map((i) => `${i.original} → ${i.replacement}`).join('; '),
      );
    },
  );
});
