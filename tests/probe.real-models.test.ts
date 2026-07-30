// Diagnostic probe, not part of the suite (INKWELL_PROBE=1 to run): sends
// Inkwell's exact prompt to real local models over BOTH request styles and
// reports where issues die in the pipeline.
//
// The "compat" path (json_object, no schema enforcement) reproduces the
// conditions Gemini gets in production — this is the closest we can get to
// the user's failing setup without their API key.
import { describe, expect, it } from 'vitest';
import { anchorIssues } from '../lib/checker/anchor';
import { buildMessages } from '../lib/checker/prompt';
import { extractJson, ISSUE_JSON_SCHEMA, parseIssuesDetailed } from '../lib/checker/schema';
import { ollamaProvider } from '../lib/providers/ollama';
import { lmStudioProvider } from '../lib/providers/openaiCompat';
import { DEFAULT_SETTINGS } from '../lib/settings/schema';

const BASE_URL = 'http://localhost:11434';
const MODEL = 'qwen2.5:7b-instruct';

const TEXTS: Record<string, string> = {
  homophones: 'Their was a problem with the code. I beleive it works now.',
  gibberish: 'mjkjkjkjkjkjkjkhkhlkhjhjhjhnmnmnmnmnmnmnmnmnmn',
  paragraph:
    "We recieved you're feedback about the delayed shippment. Their is no excuse for the " +
    'inconvenince this caused, and we could of handled it alot better. We definately will ' +
    'improve going foward.',
};

async function runPath(
  label: string,
  provider: typeof ollamaProvider,
  cfg: Parameters<typeof ollamaProvider.complete>[0],
  text: string,
) {
  const { text: response } = await provider.complete(cfg, {
    messages: buildMessages(DEFAULT_SETTINGS, text),
    temperature: 0,
    maxTokens: 2048,
    jsonSchema: ISSUE_JSON_SCHEMA,
    signal: new AbortController().signal,
  });

  let rawItems: unknown[] = [];
  try {
    const obj = extractJson(response) as { issues?: unknown[] };
    rawItems = Array.isArray(obj) ? obj : (obj.issues ?? []);
  } catch (e) {
    console.log(`\n[${label}] extractJson FAILED: ${(e as Error).message}`);
    console.log(`[${label}] raw response head: ${response.slice(0, 400)}`);
    return;
  }

  const parsed = parseIssuesDetailed(response);
  const anchored = anchorIssues(text, parsed.issues, DEFAULT_SETTINGS.categories);

  console.log(`\n[${label}]`);
  console.log(`  raw items from model : ${rawItems.length}`);
  console.log(`  survived zod         : ${parsed.issues.length} (rejected ${parsed.rejected})`);
  for (const r of parsed.reasons) console.log(`    reject reason: ${r}`);
  console.log(`  anchored in text     : ${anchored.issues.length} (dropped ${anchored.dropped})`);
  for (const item of rawItems.slice(0, 6)) {
    console.log(`    model item: ${JSON.stringify(item).slice(0, 220)}`);
  }
  for (const i of anchored.issues) {
    console.log(`    ANCHORED "${i.original}" -> "${i.replacement}" [${i.type}]`);
  }
}

describe.skipIf(!process.env.INKWELL_PROBE)('real-model pipeline probe', () => {
  for (const [name, text] of Object.entries(TEXTS)) {
    it(`native format path — ${name}`, { timeout: 300_000 }, async () => {
      await runPath(
        `ollama-native ${MODEL} ${name}`,
        ollamaProvider,
        { kind: 'ollama', baseUrl: BASE_URL, model: MODEL },
        text,
      );
      expect(true).toBe(true);
    });

    it(`compat json_object path (Gemini conditions) — ${name}`, { timeout: 300_000 }, async () => {
      await runPath(
        `compat-json_object ${MODEL} ${name}`,
        lmStudioProvider,
        { kind: 'openai-compat', baseUrl: BASE_URL, model: MODEL },
        text,
      );
      expect(true).toBe(true);
    });
  }
});
