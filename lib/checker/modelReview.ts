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

/**
 * Reviews parsed model issues before they are placed in the text: drops a
 * "correction" that swaps a spelling the writer's dialect accepts for another
 * region's form (colour to color in British English), and relabels real-word
 * mistakes that the model called spelling.
 */
export function reviewModelIssues(issues: RawIssue[], settings: Settings): RawIssue[] {
  const reviewed: RawIssue[] = [];
  for (const raw of issues) {
    if (
      knowsEveryWord(raw.original, settings) &&
      otherDialectWords(raw.replacement, settings).length > 0
    ) {
      continue;
    }
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
 * Models sometimes quote a short span but write a fix that repeats the word
 * next to it, so applying "discussed about" -> "discussed the" before "the
 * plan" would give "discussed the the plan". Trims the repeated word from the
 * fix, or drops the issue when nothing would be left to change.
 */
export function avoidRepeatedWords(text: string, issues: IssueDto[]): IssueDto[] {
  const kept: IssueDto[] = [];
  for (const issue of issues) {
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
