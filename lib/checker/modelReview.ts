// Deterministic checks on model suggestions. Small local models find real
// mistakes but often label them loosely or phrase the fix clumsily, so these
// repair what can be repaired and drop what would make the writing worse.
import type { IssueDto, IssueType } from '../messaging/protocol';
import type { Settings } from '../settings/schema';
import { knowsEveryWord, otherDialectWords } from './localSpelling';
import { ALLOWED_REPEATS } from './localRules';
import type { RawIssue } from './schema';

const WORD_SOURCE = String.raw`\p{L}+(?:['’]\p{L}+)*`;
const LAST_WORD = new RegExp(`(${WORD_SOURCE})$`, 'u');
const FIRST_WORD = new RegExp(`^(${WORD_SOURCE})`, 'u');
const NEXT_WORD = new RegExp(`^(\\s+)(${WORD_SOURCE})(?![\\p{L}\\p{N}])`, 'u');
const PREVIOUS_WORD = new RegExp(`(?<![\\p{L}\\p{N}'’])(${WORD_SOURCE})(\\s+)$`, 'u');

function sameWord(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const lower = left.toLocaleLowerCase('en');
  return lower === right.toLocaleLowerCase('en') && !ALLOWED_REPEATS.has(lower);
}

/**
 * A "spelling" issue whose words are all real words is about how they are
 * used. Labelling it spelling would offer "Add to dictionary" for a grammar
 * mistake, so it is relabelled from the text itself.
 */
function correctedType(raw: RawIssue, settings: Settings): IssueType {
  if (raw.type !== 'spelling' || !knowsEveryWord(raw.original, settings)) return raw.type;
  const bare = (value: string) => value.replace(/[^\p{L}\p{N}'’]/gu, '');
  return bare(raw.original) === bare(raw.replacement) ? 'punctuation' : 'grammar';
}

const ARTICLES = new Set(['a', 'an', 'the']);
const MALE = new Set(['he', 'him', 'his', 'himself']);
const FEMALE = new Set(['she', 'her', 'hers', 'herself']);

function lowerWords(text: string): string[] {
  return (text.match(new RegExp(WORD_SOURCE, 'gu')) ?? []).map((word) =>
    word.replaceAll('’', "'").toLocaleLowerCase('en'),
  );
}

function isSubsequence(short: string[], long: string[]): boolean {
  let index = 0;
  for (const word of long) if (word === short[index]) index++;
  return index === short.length;
}

/**
 * Fixes that make the writing worse in ways small models often get wrong.
 * Each one either changes the meaning or swaps a correct form for an
 * incorrect one, so it is dropped rather than repaired.
 */
function makesWritingWorse(raw: RawIssue, settings: Settings): boolean {
  const before = lowerWords(raw.original);
  const after = lowerWords(raw.replacement);
  const count = (words: string[], set: ReadonlySet<string>) =>
    words.filter((word) => set.has(word)).length;

  // colour to color for someone writing British English.
  if (knowsEveryWord(raw.original, settings) && otherDialectWords(raw.replacement, settings).length > 0) {
    return true;
  }
  // "Your the" to "You're" silently deletes the article the span ends on.
  // Plain deletions such as "the the" to "the", and rewrites that keep an
  // article at the end, are kept.
  const lastBefore = before.at(-1);
  const lastAfter = after.at(-1);
  if (
    lastBefore !== undefined &&
    ARTICLES.has(lastBefore) &&
    !(lastAfter !== undefined && ARTICLES.has(lastAfter)) &&
    !isSubsequence(after, before)
  ) {
    return true;
  }
  // "than her" to "than his" changes who the sentence is about.
  const genderSwap =
    (count(before, FEMALE) > count(after, FEMALE) && count(after, MALE) > count(before, MALE)) ||
    (count(before, MALE) > count(after, MALE) && count(after, FEMALE) > count(before, FEMALE));
  if (genderSwap) return true;
  // "fewer people" is already right.
  if (before.includes('fewer') && !after.includes('fewer') && after.includes('less')) return true;
  // "I and him" is never the fix for "me and him".
  return /\bI and (?:he|she|they|him|her|them)\b/u.test(raw.replacement) &&
    !/\bI and (?:he|she|they|him|her|them)\b/u.test(raw.original);
}

/**
 * Reviews parsed model issues before they are placed in the text: drops
 * fixes that would make the writing worse, such as swapping a spelling the
 * writer's dialect accepts for another region's form (colour to color in
 * British English), and relabels real-word mistakes the model called spelling.
 */
export function reviewModelIssues(issues: RawIssue[], settings: Settings): RawIssue[] {
  const reviewed: RawIssue[] = [];
  for (const raw of issues) {
    if (makesWritingWorse(raw, settings)) continue;
    reviewed.push({ ...raw, type: correctedType(raw, settings) });
  }
  return reviewed;
}

/**
 * Turns an empty replacement into a clean deletion by taking one neighbouring
 * run of whitespace with the removed words.
 */
function asDeletion(text: string, issue: IssueDto): IssueDto {
  let { start, end } = issue;
  const before = /\s+$/u.exec(text.slice(0, start));
  const after = /^\s+/u.exec(text.slice(end));
  if (before && start - before[0].length > 0) start -= before[0].length;
  else if (after) end += after[0].length;
  return { ...issue, start, end, original: text.slice(start, end), replacement: '' };
}

/**
 * "then" to "than" needs something to compare with, so "We were happier
 * then." is left alone, as the offline rule does.
 */
function comparesNothing(text: string, issue: IssueDto): boolean {
  return (
    LAST_WORD.exec(issue.original)?.[1]?.toLocaleLowerCase('en') === 'then' &&
    LAST_WORD.exec(issue.replacement)?.[1]?.toLocaleLowerCase('en') === 'than' &&
    /^\s*(?:[^\p{L}\p{N}\s]|$)/u.test(text.slice(issue.end))
  );
}

/**
 * Reviews model issues once they are placed in the text. Models sometimes
 * quote a short span but write a fix that repeats the word next to it, so
 * applying "discussed about" -> "discussed the" before "the plan" would give
 * "discussed the the plan". The repeated word is trimmed from the fix, or the
 * issue is dropped when nothing would be left to change.
 */
export function reviewPlacedIssues(text: string, issues: IssueDto[]): IssueDto[] {
  const kept: IssueDto[] = [];
  for (const issue of issues) {
    if (comparesNothing(text, issue)) continue;
    let replacement = issue.replacement;

    const next = NEXT_WORD.exec(text.slice(issue.end));
    const last = LAST_WORD.exec(replacement)?.[1];
    if (sameWord(last, next?.[2]) && !sameWord(LAST_WORD.exec(issue.original)?.[1], next?.[2])) {
      replacement = replacement.slice(0, replacement.length - last!.length).replace(/\s+$/u, '');
    }

    const previous = PREVIOUS_WORD.exec(text.slice(0, issue.start));
    const first = FIRST_WORD.exec(replacement)?.[1];
    if (
      sameWord(first, previous?.[1]) &&
      !sameWord(FIRST_WORD.exec(issue.original)?.[1], previous?.[1])
    ) {
      replacement = replacement.slice(first!.length).replace(/^\s+/u, '');
    }

    if (replacement === issue.replacement) {
      kept.push(issue);
    } else if (replacement === '') {
      kept.push(asDeletion(text, issue));
    } else if (replacement !== issue.original) {
      kept.push({ ...issue, replacement });
    }
  }
  return kept;
}
