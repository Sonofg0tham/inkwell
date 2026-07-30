import enUsAff from '../../node_modules/dictionary-en/index.aff?raw';
import enUsDic from '../../node_modules/dictionary-en/index.dic?raw';
import enAuAff from '../../node_modules/dictionary-en-au/index.aff?raw';
import enAuDic from '../../node_modules/dictionary-en-au/index.dic?raw';
import enCaAff from '../../node_modules/dictionary-en-ca/index.aff?raw';
import enCaDic from '../../node_modules/dictionary-en-ca/index.dic?raw';
import enGbAff from '../../node_modules/dictionary-en-gb/index.aff?raw';
import enGbDic from '../../node_modules/dictionary-en-gb/index.dic?raw';
// nspell is browser-compatible but does not publish TypeScript declarations.
// @ts-expect-error -- the small interface below is the API surface we use.
import nspell from 'nspell';
import type { IssueDto } from '../messaging/protocol';
import type { Settings } from '../settings/schema';
import { fnvHash } from './hash';

interface SpellChecker {
  correct(word: string): boolean;
  suggest(word: string): string[];
}

type Dialect = Settings['dialect'];

const MAX_LOCAL_ISSUES = 100;
const WORD = /[\p{L}]+(?:['\u2019-][\p{L}]+)*/gu;

const COMMON_MISSPELLINGS: Readonly<Record<string, string>> = {
  alot: 'a lot',
  beleive: 'believe',
  definately: 'definitely',
  occured: 'occurred',
  recieve: 'receive',
  seperate: 'separate',
  teh: 'the',
  tommorow: 'tomorrow',
  wierd: 'weird',
};

const BRITISH_FORMS: Readonly<Record<string, string>> = {
  color: 'colour',
  colors: 'colours',
  colored: 'coloured',
  coloring: 'colouring',
  center: 'centre',
  centers: 'centres',
  centered: 'centred',
  organize: 'organise',
  organizes: 'organises',
  organized: 'organised',
  organizing: 'organising',
  recognize: 'recognise',
  recognizes: 'recognises',
  recognized: 'recognised',
  recognizing: 'recognising',
};

const AMERICAN_FORMS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(BRITISH_FORMS).map(([american, british]) => [british, american]),
);

const CANADIAN_FORMS: Readonly<Record<string, string>> = {
  color: 'colour',
  colors: 'colours',
  colored: 'coloured',
  coloring: 'colouring',
  center: 'centre',
  centers: 'centres',
  centered: 'centred',
  organise: 'organize',
  organises: 'organizes',
  organised: 'organized',
  organising: 'organizing',
  recognise: 'recognize',
  recognises: 'recognizes',
  recognised: 'recognized',
  recognising: 'recognizing',
};

const REGIONAL_FORMS: Readonly<Record<Dialect, Readonly<Record<string, string>>>> = {
  'en-US': AMERICAN_FORMS,
  'en-GB': BRITISH_FORMS,
  'en-CA': CANADIAN_FORMS,
  'en-AU': BRITISH_FORMS,
  // No maintained en-IN package is available, so Indian English uses the
  // British dictionary and spelling baseline documented in the prompt.
  'en-IN': BRITISH_FORMS,
};

const DIALECT_LABELS: Readonly<Record<Dialect, string>> = {
  'en-GB': 'British English',
  'en-US': 'American English',
  'en-CA': 'Canadian English',
  'en-AU': 'Australian English',
  'en-IN': 'Indian English',
};

const DICTIONARIES: Readonly<Record<Dialect, { aff: string; dic: string }>> = {
  'en-US': { aff: enUsAff, dic: enUsDic },
  'en-GB': { aff: enGbAff, dic: enGbDic },
  'en-CA': { aff: enCaAff, dic: enCaDic },
  'en-AU': { aff: enAuAff, dic: enAuDic },
  'en-IN': { aff: enGbAff, dic: enGbDic },
};

const SPELLERS = new Map<Dialect, SpellChecker>();

interface TextRange {
  start: number;
  end: number;
}

const PROTECTED_PATTERNS = [
  /(?:https?:\/\/|www\.)[^\s<>"']+/giu,
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu,
  /@[\p{L}\p{N}_]+/gu,
  /`[^`\r\n]*`/g,
  /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\([^\r\n)]*\))?/g,
  /(?:[A-Za-z]:\\|\.\.?\/)[^\s<>"']+/g,
] as const;

const IDENTIFIER_PATTERN = /\b[A-Za-z_][A-Za-z0-9_$]*\b/g;

function getSpeller(dialect: Dialect): SpellChecker {
  const cached = SPELLERS.get(dialect);
  if (cached) return cached;
  const dictionary = DICTIONARIES[dialect];
  const checker = nspell(dictionary.aff, dictionary.dic) as SpellChecker;
  SPELLERS.set(dialect, checker);
  return checker;
}

function collectPatternRanges(
  text: string,
  pattern: RegExp,
  ranges: TextRange[],
  accept: (value: string) => boolean = () => true,
): void {
  pattern.lastIndex = 0;
  for (;;) {
    const match = pattern.exec(text);
    if (!match) break;
    if (accept(match[0])) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
    if (match[0].length === 0) pattern.lastIndex++;
  }
}

function protectedRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  for (const pattern of PROTECTED_PATTERNS) collectPatternRanges(text, pattern, ranges);
  collectPatternRanges(text, IDENTIFIER_PATTERN, ranges, (value) => value.includes('_'));
  return ranges;
}

function isProtected(start: number, end: number, ranges: TextRange[]): boolean {
  return ranges.some((range) => start < range.end && range.start < end);
}

function isMixedCase(word: string): boolean {
  const lower = word.toLocaleLowerCase('en');
  const title = lower[0]?.toLocaleUpperCase('en') + lower.slice(1);
  const upper = word.toLocaleUpperCase('en');
  return word !== lower && word !== title && word !== upper;
}

function isTitleCase(word: string): boolean {
  const lower = word.toLocaleLowerCase('en');
  return word === lower[0]?.toLocaleUpperCase('en') + lower.slice(1);
}

function matchCase(original: string, replacement: string): string {
  if (!isTitleCase(original)) return replacement;
  const first = replacement[0];
  return first ? first.toLocaleUpperCase('en') + replacement.slice(1) : replacement;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    let diagonal = previous[0]!;
    previous[0] = row;
    for (let column = 1; column <= right.length; column++) {
      const above = previous[column]!;
      previous[column] = Math.min(
        previous[column]! + 1,
        previous[column - 1]! + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length]!;
}

function bestSuggestion(checker: SpellChecker, word: string): string | null {
  const suggestions = checker.suggest(word);
  // A case-only suggestion usually means the token is a known proper noun.
  if (suggestions.some((suggestion) => suggestion.toLocaleLowerCase('en') === word)) return null;
  const maxDistance = word.length >= 9 ? 3 : 2;
  return (
    suggestions.find((suggestion) => {
      if (!/^[A-Za-z]+(?:['-][A-Za-z]+)*$/.test(suggestion)) return false;
      return editDistance(word, suggestion.toLocaleLowerCase('en')) <= maxDistance;
    }) ?? null
  );
}

function makeIssue(
  original: string,
  replacement: string,
  start: number,
  occurrence: number,
  explanation: string,
): IssueDto {
  return {
    id: fnvHash(`spelling:${original}:${occurrence}:${replacement}`),
    type: 'spelling',
    start,
    end: start + original.length,
    original,
    replacement: matchCase(original, replacement),
    explanation,
  };
}

/**
 * Runs a deterministic, offline spelling pass over one checker chunk. The
 * dictionaries are imported as text assets so the background worker never
 * depends on Node's filesystem APIs.
 */
export function findLocalSpellingIssues(text: string, settings: Settings): IssueDto[] {
  if (!settings.categories.spelling || text.trim() === '') return [];

  const checker = getSpeller(settings.dialect);
  const protectedText = protectedRanges(text);
  const personal = new Set((settings.personalDictionary ?? []).map(normalisePersonalWord));
  const occurrences = new Map<string, number>();
  const regional = REGIONAL_FORMS[settings.dialect];
  const issues: IssueDto[] = [];

  WORD.lastIndex = 0;
  for (;;) {
    const match = WORD.exec(text);
    if (!match) break;
    const original = match[0];
    const start = match.index;
    const end = start + original.length;
    if (isProtected(start, end, protectedText)) continue;
    if (original.includes('-') || /[^\x00-\x7F\u2019]/.test(original)) continue;
    if (original.length > 1 && original === original.toLocaleUpperCase('en')) continue;
    if (isMixedCase(original)) continue;

    const normalized = original.replaceAll('\u2019', "'").toLocaleLowerCase('en');
    if (personal.has(normalized)) continue;

    let replacement = COMMON_MISSPELLINGS[normalized] ?? regional[normalized];
    let explanation = 'Possible spelling mistake.';
    if (regional[normalized]) {
      explanation = `Use the ${DIALECT_LABELS[settings.dialect]} spelling.`;
    }

    if (!replacement) {
      // Capitalised unknown words are overwhelmingly names, products or places.
      if (isTitleCase(original) || normalized.length < 4 || checker.correct(normalized)) continue;
      replacement = bestSuggestion(checker, normalized) ?? undefined;
    }
    if (!replacement || replacement === normalized) continue;

    const occurrence = (occurrences.get(normalized) ?? 0) + 1;
    occurrences.set(normalized, occurrence);
    issues.push(makeIssue(original, replacement, start, occurrence, explanation));
    if (issues.length >= MAX_LOCAL_ISSUES) break;
  }

  return issues;
}

function overlaps(left: IssueDto, right: IssueDto): boolean {
  return left.start < right.end && right.start < left.end;
}

function normalisePersonalWord(word: string): string {
  return word.replaceAll('\u2019', "'").toLocaleLowerCase('en');
}

/** A model does not get to override the user's explicit dictionary choice. */
export function filterPersonalDictionaryIssues(
  issues: IssueDto[],
  settings: Settings,
): IssueDto[] {
  const personal = new Set((settings.personalDictionary ?? []).map(normalisePersonalWord));
  if (personal.size === 0) return issues;
  return issues.filter(
    (issue) => issue.type !== 'spelling' || !personal.has(normalisePersonalWord(issue.original)),
  );
}

/** Deterministic local spelling takes precedence over uncertain model output. */
export function mergeLocalSpellingIssues(
  localIssues: IssueDto[],
  modelIssues: IssueDto[],
): IssueDto[] {
  const merged = [
    ...localIssues,
    ...modelIssues.filter(
      (modelIssue) => !localIssues.some((localIssue) => overlaps(localIssue, modelIssue)),
    ),
  ];
  return merged.sort((left, right) => left.start - right.start || left.end - right.end);
}
