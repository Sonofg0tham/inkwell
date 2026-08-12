import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  loadSettings: vi.fn(),
  loadSecret: vi.fn(),
}));

vi.mock('../lib/providers/registry', () => ({
  getProvider: () => ({
    complete: mocks.complete,
    listModels: vi.fn(),
    testConnection: vi.fn(),
  }),
}));

vi.mock('../lib/settings/store', () => ({
  loadSettings: mocks.loadSettings,
  loadSecret: mocks.loadSecret,
}));

import { CheckService } from '../lib/checker/service';
import { findLocalSpellingIssues } from '../lib/checker/localSpelling';
import { buildSystemPrompt } from '../lib/checker/prompt';
import type { IssueDto, PortResponse } from '../lib/messaging/protocol';
import { ProviderError } from '../lib/providers/types';
import { DEFAULT_SETTINGS, settingsSchema, type Settings } from '../lib/settings/schema';

const CLIENT = { id: 'local-spelling-test', origin: 'https://example.test' };

async function check(
  text: string,
  settings: Settings,
  modelIssues: Array<Record<string, unknown>> = [],
): Promise<IssueDto[]> {
  mocks.loadSettings.mockResolvedValue(settings);
  mocks.complete.mockResolvedValue({ text: JSON.stringify({ issues: modelIssues }) });

  const responses: PortResponse[] = [];
  const service = new CheckService(() => undefined);
  service.enqueue(CLIENT, crypto.randomUUID(), 'client-hash', text, (response) => {
    responses.push(response);
  });

  await vi.waitFor(() => expect(responses).toHaveLength(1));
  const response = responses[0]!;
  expect(response.t).toBe('result');
  if (response.t !== 'result') return [];
  return response.issues;
}

describe('English dialect settings', () => {
  it.each([
    ['en-GB', 'British English'],
    ['en-US', 'American English'],
    ['en-CA', 'Canadian English'],
    ['en-AU', 'Australian English'],
    ['en-IN', 'Indian English'],
  ] as const)('supports %s and gives the model explicit dialect guidance', (dialect, wording) => {
    const settings = settingsSchema.parse({ dialect });

    expect(settings.dialect).toBe(dialect);
    expect(buildSystemPrompt(settings)).toContain(wording);
  });
});

describe('deterministic local spelling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadSecret.mockResolvedValue(undefined);
  });

  it('finds common misspellings when the model reports no issues', async () => {
    const issues = await check(
      'I definately recieve teh message tomorrow.',
      DEFAULT_SETTINGS,
    );

    expect(issues.map(({ original, replacement }) => ({ original, replacement }))).toEqual([
      { original: 'definately', replacement: 'definitely' },
      { original: 'recieve', replacement: 'receive' },
      { original: 'teh', replacement: 'the' },
    ]);
  });

  it('still returns deterministic spelling when the contextual model is unavailable', async () => {
    mocks.loadSettings.mockResolvedValue(DEFAULT_SETTINGS);
    mocks.complete.mockRejectedValue(new ProviderError('network', 'Local model unavailable.'));
    const responses: PortResponse[] = [];
    const service = new CheckService(() => undefined);
    service.enqueue(CLIENT, crypto.randomUUID(), 'client-hash', 'Their is teh message.', (response) => {
      responses.push(response);
    });

    await vi.waitFor(() => expect(responses).toHaveLength(1));
    expect(responses[0]).toMatchObject({
      t: 'result',
      issues: [
        expect.objectContaining({ type: 'grammar', original: 'Their', replacement: 'There' }),
        expect.objectContaining({ type: 'spelling', original: 'teh', replacement: 'the' }),
      ],
      incomplete: { code: 'network', hint: 'Local model unavailable.' },
    });
  });

  it('uses the selected regional dictionary, including the en-IN fallback', async () => {
    const cases = [
      ['en-US', 'colour', 'color'],
      ['en-GB', 'color', 'colour'],
      ['en-CA', 'color', 'colour'],
      ['en-AU', 'color', 'colour'],
      ['en-IN', 'color', 'colour'],
    ] as const;

    for (const [dialect, original, replacement] of cases) {
      const settings = settingsSchema.parse({ dialect });
      const issues = await check(`The ${original} is clear.`, settings);
      expect(issues).toEqual([
        expect.objectContaining({ type: 'spelling', original, replacement }),
      ]);
    }
  });

  it('skips protected and code-like text plus obvious proper nouns', async () => {
    const issues = await check(
      'Craig uses openAIWidget and obj.recieve() at https://examplle.test, emails craigg@example.test, then mentions Inkwell but definately waits.',
      DEFAULT_SETTINGS,
    );

    expect(issues).toEqual([
      expect.objectContaining({ original: 'definately', replacement: 'definitely' }),
    ]);
  });

  it('handles long underscored identifiers without pathological regular-expression backtracking', () => {
    const identifier = `prefix_${'$__'.repeat(10_000)}suffix`;

    expect(findLocalSpellingIssues(identifier, DEFAULT_SETTINGS)).toEqual([]);
    expect(findLocalSpellingIssues('recieve_value', DEFAULT_SETTINGS)).toEqual([]);
  });

  it('honours spelling category and personal dictionary settings', async () => {
    const spellingOff = settingsSchema.parse({
      categories: { ...DEFAULT_SETTINGS.categories, spelling: false },
    });
    expect(await check('teh inkwello', spellingOff)).toEqual([]);

    expect(await check('inkwello', DEFAULT_SETTINGS)).toEqual([
      expect.objectContaining({ original: 'inkwello', replacement: 'inkwell' }),
    ]);
    const personalWord = settingsSchema.parse({ personalDictionary: ['inkwello'] });
    expect(await check('inkwello', personalWord)).toEqual([]);
  });

  it('does not let the contextual model reintroduce a saved dictionary word', async () => {
    const settings = settingsSchema.parse({ personalDictionary: ['Inkwello'] });
    const issues = await check('Inkwello makes useful tools.', settings, [
      {
        type: 'spelling',
        original: 'Inkwello',
        replacement: 'Inkwell',
        explanation: 'Possible misspelling.',
      },
    ]);

    expect(issues).toEqual([]);
  });

  it('filters model style issues in standard mode while retaining other categories', async () => {
    const issues = await check('We use a very simple plan.', DEFAULT_SETTINGS, [
      {
        type: 'style',
        original: 'very simple',
        replacement: 'straightforward',
        explanation: 'Prefer a more concise phrase.',
      },
      {
        type: 'grammar',
        original: 'We use',
        replacement: 'They use',
        explanation: 'Example grammar correction.',
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({ type: 'grammar', original: 'We use', replacement: 'They use' }),
    ]);
  });

  it('retains a model style issue in picky mode', async () => {
    const settings = settingsSchema.parse({ strictness: 'picky' });
    const issues = await check(
      'Due to the fact that it was raining, we stayed inside.',
      settings,
      [
        {
          type: 'style',
          original: 'Due to the fact that it was raining, we stayed inside.',
          replacement: 'Because it was raining, we stayed inside.',
          explanation: 'Wordy and can be simplified.',
        },
      ],
    );

    expect(issues).toEqual([
      expect.objectContaining({
        type: 'style',
        original: 'Due to the fact that it was raining, we stayed inside.',
        replacement: 'Because it was raining, we stayed inside.',
      }),
    ]);
  });

  it('keeps deterministic spelling on overlaps while retaining separate model issues', async () => {
    const issues = await check('I recieve mail.', DEFAULT_SETTINGS, [
      {
        type: 'grammar',
        original: 'I',
        replacement: 'We',
        explanation: 'Prefer the collective voice.',
      },
      {
        type: 'spelling',
        original: 'recieve',
        replacement: 'retrieve',
        explanation: 'Model guessed the wrong correction.',
      },
    ]);

    expect(issues).toHaveLength(2);
    expect(issues).toEqual([
      expect.objectContaining({ type: 'grammar', original: 'I', replacement: 'We' }),
      expect.objectContaining({ type: 'spelling', original: 'recieve', replacement: 'receive' }),
    ]);
  });
});
