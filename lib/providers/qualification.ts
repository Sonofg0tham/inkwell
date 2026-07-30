import { anchorIssues } from '../checker/anchor';
import { buildMessages } from '../checker/prompt';
import { ISSUE_JSON_SCHEMA, parseIssuesDetailed } from '../checker/schema';
import type { Settings } from '../settings/schema';
import {
  ProviderError,
  type Provider,
  type ResolvedProviderConfig,
  type TestResult,
} from './types';

export const QUALIFICATION_PASSAGE = 'They will recieve the parcel tommorow.';

const ALL_CATEGORIES = {
  spelling: true,
  grammar: true,
  punctuation: true,
  style: true,
} as const;

function applyLocatedIssues(
  text: string,
  issues: ReturnType<typeof anchorIssues>['issues'],
): string {
  let corrected = text;
  for (const issue of [...issues].sort((a, b) => b.start - a.start)) {
    if (corrected.slice(issue.start, issue.end) !== issue.original) continue;
    corrected = corrected.slice(0, issue.start) + issue.replacement + corrected.slice(issue.end);
  }
  return corrected;
}

function unsuitable(hint: string): TestResult {
  return { ok: false, code: 'bad_response', hint };
}

/**
 * Proves more than reachability: the selected model must produce structured,
 * anchorable output and correct at least one obvious spelling error.
 */
export async function qualifyProofreadingProvider(
  provider: Provider,
  cfg: ResolvedProviderConfig,
  settings: Settings,
): Promise<TestResult> {
  const connected = await provider.testConnection(cfg);
  if (!connected.ok) return connected;

  try {
    const response = await provider.complete(cfg, {
      messages: buildMessages(settings, QUALIFICATION_PASSAGE),
      temperature: 0,
      maxTokens: 512,
      jsonSchema: ISSUE_JSON_SCHEMA,
      signal: new AbortController().signal,
    });
    const parsed = parseIssuesDetailed(response.text);
    if (parsed.rejected > 0) {
      return unsuitable(
        'Connected, but the model returned malformed issue fields. Choose a different instruct model with reliable structured JSON output.',
      );
    }
    const anchored = anchorIssues(QUALIFICATION_PASSAGE, parsed.issues, ALL_CATEGORIES);
    if (anchored.dropped > 0 || anchored.issues.length === 0) {
      return unsuitable(
        'Connected, but the model quoted text Inkwell could not locate in its test passage. Choose a stronger instruct model.',
      );
    }

    const corrected = applyLocatedIssues(QUALIFICATION_PASSAGE, anchored.issues).toLowerCase();
    const fixedKnownError =
      (!corrected.includes('recieve') && corrected.includes('receive')) ||
      (!corrected.includes('tommorow') && corrected.includes('tomorrow'));
    if (!fixedKnownError) {
      return unsuitable(
        'Connected, but the model missed the obvious spelling errors in Inkwell’s test passage. Choose a stronger proofreading model.',
      );
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof ProviderError && err.code !== 'bad_response') {
      return { ok: false, code: err.code, hint: err.message };
    }
    return unsuitable(
      'Connected, but the model did not return usable structured JSON. Choose a different instruct model with JSON support.',
    );
  }
}
