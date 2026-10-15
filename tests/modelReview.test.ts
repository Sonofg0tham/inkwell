import { describe, expect, it } from 'vitest';
import type { IssueDto } from '../lib/messaging/protocol';
import { reviewPlacedIssues, reviewModelIssues } from '../lib/checker/modelReview';
import type { RawIssue } from '../lib/checker/schema';
import { DEFAULT_SETTINGS, settingsSchema, type Settings } from '../lib/settings/schema';

const raw = (
  type: RawIssue['type'],
  original: string,
  replacement: string,
): RawIssue => ({ type, original, replacement, explanation: 'x' });

const dialect = (value: Settings['dialect']): Settings => settingsSchema.parse({ dialect: value });

function located(text: string, original: string, replacement: string): IssueDto {
  const start = text.indexOf(original);
  return {
    id: 'model',
    type: 'grammar',
    start,
    end: start + original.length,
    original,
    replacement,
    explanation: 'x',
  };
}

function apply(text: string, issues: IssueDto[]): string {
  return [...issues]
    .sort((a, b) => b.start - a.start)
    .reduce((out, issue) => out.slice(0, issue.start) + issue.replacement + out.slice(issue.end), text);
}

describe('model issue labels', () => {
  it.each([
    ['She walk', 'She walks', 'grammar'],
    ['their', 'there', 'grammar'],
    ['its', "it's", 'grammar'],
    ['i', 'I', 'grammar'],
    ['hello ,', 'hello,', 'punctuation'],
    ['recieve', 'receive', 'spelling'],
    ['Jhon', 'John', 'spelling'],
  ] as const)('labels a "spelling" fix of %j to %j as %s', (original, replacement, type) => {
    const [issue] = reviewModelIssues([raw('spelling', original, replacement)], DEFAULT_SETTINGS);
    expect(issue?.type).toBe(type);
  });

  it('leaves labels other than spelling alone', () => {
    const issues = reviewModelIssues(
      [raw('style', 'in order to', 'to'), raw('punctuation', '! !', '!')],
      DEFAULT_SETTINGS,
    );
    expect(issues.map((issue) => issue.type)).toEqual(['style', 'punctuation']);
  });

  it("treats the writer's personal dictionary as real words", () => {
    const settings = settingsSchema.parse({ personalDictionary: ['qwen'] });
    const [issue] = reviewModelIssues([raw('spelling', 'qwen walk', 'qwen walks')], settings);
    expect(issue?.type).toBe('grammar');
  });
});

describe('regional spelling swaps', () => {
  it.each([
    ['en-GB', 'colour', 'color'],
    ['en-GB', 'organise', 'organize'],
    ['en-GB', 'travelling', 'traveling'],
    ['en-AU', 'favourite', 'favorite'],
    ['en-CA', 'colour', 'color'],
    ['en-US', 'color', 'colour'],
    ['en-GB', 'The colour', 'The color'],
  ] as const)('drops a %s change from %j to %j', (value, original, replacement) => {
    expect(reviewModelIssues([raw('spelling', original, replacement)], dialect(value))).toEqual([]);
  });

  it.each([
    ['en-US', 'colour', 'color'],
    ['en-GB', 'color', 'colour'],
    ['en-GB', 'recieve', 'receive'],
    ['en-GB', 'cyber security', 'cybersecurity'],
  ] as const)('keeps a %s change from %j to %j', (value, original, replacement) => {
    expect(reviewModelIssues([raw('spelling', original, replacement)], dialect(value))).toHaveLength(1);
  });
});

describe('fixes that make the writing worse', () => {
  it.each([
    ['Your the', "You're"],
    ['less friends than her', 'fewer friends than his'],
    ['Fewer', 'Less'],
    ['Me and him', 'I and him'],
  ] as const)('drops a change from %j to %j', (original, replacement) => {
    expect(reviewModelIssues([raw('grammar', original, replacement)], DEFAULT_SETTINGS)).toEqual([]);
  });

  it.each([
    ['a apple', 'an apple'],
    ['a', 'an'],
    ['Due to the fact that', 'Because'],
    ['the the', 'the'],
    ['went to the home', 'went home'],
    ['than her', 'than she'],
    ['less friends', 'fewer friends'],
    ['Me and him', 'He and I'],
  ] as const)('keeps a change from %j to %j', (original, replacement) => {
    expect(reviewModelIssues([raw('grammar', original, replacement)], DEFAULT_SETTINGS)).toHaveLength(1);
  });

  it('drops "then" to "than" when nothing follows to compare with', () => {
    const ended = 'We were happier then.';
    const compared = 'We were happier then before.';
    expect(reviewPlacedIssues(ended, [located(ended, 'then', 'than')])).toEqual([]);
    expect(reviewPlacedIssues(compared, [located(compared, 'then', 'than')])).toHaveLength(1);
  });
});

describe('repeated words in model fixes', () => {
  it('trims a word the fix repeats from the text after it', () => {
    const text = 'We discussed about the plan.';
    const issues = reviewPlacedIssues(text, [located(text, 'discussed about', 'discussed the')]);
    expect(apply(text, issues)).toBe('We discussed the plan.');
  });

  it('turns a fix that only repeats the next word into a clean deletion', () => {
    const text = 'We discussed about the plan.';
    const issues = reviewPlacedIssues(text, [located(text, 'about', 'the')]);
    expect(issues[0]?.original).toBe(' about');
    expect(apply(text, issues)).toBe('We discussed the plan.');
  });

  it('trims a word the fix repeats from the text before it', () => {
    const text = 'He wants to going home.';
    const issues = reviewPlacedIssues(text, [located(text, 'going', 'to go')]);
    expect(apply(text, issues)).toBe('He wants to go home.');
  });

  it('drops a fix that changes nothing once the repeat is trimmed', () => {
    const text = 'We discussed the plan.';
    expect(reviewPlacedIssues(text, [located(text, 'discussed', 'discussed the')])).toEqual([]);
  });

  it('leaves correct repeats, existing repeats and ordinary fixes alone', () => {
    const allowed = 'I know that it is fine.';
    const existing = 'We went to the the shop.';
    const ordinary = 'She walk to work.';
    for (const [text, issue] of [
      [allowed, located(allowed, 'it is', 'that is')],
      [existing, located(existing, 'the shop', 'the store')],
      [ordinary, located(ordinary, 'She walk', 'She walks')],
    ] as const) {
      expect(reviewPlacedIssues(text, [issue])).toEqual([issue]);
    }
  });
});
