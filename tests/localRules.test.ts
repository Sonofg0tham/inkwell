import { describe, expect, it } from 'vitest';
import { findLocalRuleIssues } from '../lib/checker/localRules';
import { DEFAULT_SETTINGS, settingsSchema } from '../lib/settings/schema';

describe('deterministic local grammar and punctuation', () => {
  it('finds a small set of high-confidence errors', () => {
    const issues = findLocalRuleIssues(
      'Their is a problem , and we could of prevented it. Your welcome.',
      DEFAULT_SETTINGS,
    );

    expect(issues.map(({ type, original, replacement }) => ({ type, original, replacement }))).toEqual([
      { type: 'grammar', original: 'Their', replacement: 'There' },
      { type: 'punctuation', original: ' ,', replacement: ',' },
      { type: 'grammar', original: 'of', replacement: 'have' },
      { type: 'grammar', original: 'Your', replacement: "You're" },
    ]);
  });

  it('honours disabled categories', () => {
    const settings = settingsSchema.parse({
      categories: { ...DEFAULT_SETTINGS.categories, grammar: false, punctuation: false },
    });
    expect(findLocalRuleIssues('Their is a problem , and we could of helped.', settings)).toEqual([]);
  });

  it('does not apply rules inside URLs, email addresses or inline code', () => {
    const issues = findLocalRuleIssues(
      'Visit https://example.test/their is or email their@example.test. Keep `their is` unchanged.',
      DEFAULT_SETTINGS,
    );
    expect(issues).toEqual([]);
  });
});
