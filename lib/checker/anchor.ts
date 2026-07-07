import type { IssueDto, IssueType } from '../messaging/protocol';
import { fnvHash } from './hash';
import type { RawIssue } from './schema';

/**
 * Rejects C0 control characters in replacements (output sanitisation).
 * Tab, LF and CR are allowed; everything else below 0x20 is not.
 */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
  }
  return false;
}

/** All start indices of `needle` in `haystack`. */
function allIndices(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + 1;
  }
  return out;
}

interface Normalized {
  text: string;
  /** map[i] = index in the original string of normalised char i */
  map: number[];
}

const WHITESPACE = /\s/;

/**
 * Normalises typographic variants (curly quotes, NBSP, dashes) and collapses
 * whitespace runs, keeping an index map back to the original string.
 */
function normalize(input: string): Normalized {
  const chars: string[] = [];
  const map: number[] = [];
  let prevWasSpace = false;
  for (let i = 0; i < input.length; i++) {
    let c = input[i]!;
    if (WHITESPACE.test(c)) c = ' ';
    else if (c === '‘' || c === '’') c = "'";
    else if (c === '“' || c === '”') c = '"';
    else if (c === '–' || c === '—') c = '-';
    if (c === ' ') {
      if (prevWasSpace) continue;
      prevWasSpace = true;
    } else {
      prevWasSpace = false;
    }
    chars.push(c);
    map.push(i);
  }
  return { text: chars.join(''), map };
}

function pickOccurrence(indices: number[], occurrence: number | undefined): number | null {
  if (indices.length === 0) return null;
  const n = occurrence ?? 1;
  if (n > indices.length) return null; // provably wrong claim — drop, never guess
  return indices[n - 1]!;
}

export function issueId(issue: RawIssue): string {
  return fnvHash(`${issue.type}:${issue.original}:${issue.occurrence ?? 1}:${issue.replacement}`);
}

/**
 * Locates raw model issues in the chunk text. LLM offsets are never trusted —
 * only verbatim substring matches count. Unfindable issues are dropped.
 */
export function locateIssues(
  chunkText: string,
  rawIssues: RawIssue[],
  enabledCategories: Record<IssueType, boolean>,
): IssueDto[] {
  const located: IssueDto[] = [];

  for (const raw of rawIssues) {
    if (!enabledCategories[raw.type]) continue;
    if (raw.replacement === raw.original) continue;
    if (raw.original.trim() === '') continue;
    if (hasControlChars(raw.replacement)) continue;

    let start: number | null = null;
    let end: number | null = null;

    // Pass 1: exact match.
    const exact = pickOccurrence(allIndices(chunkText, raw.original), raw.occurrence);
    if (exact !== null) {
      start = exact;
      end = exact + raw.original.length;
    }

    // Pass 2: typography-normalised match, mapped back to original offsets.
    if (start === null) {
      const normText = normalize(chunkText);
      const normNeedle = normalize(raw.original);
      const idx = pickOccurrence(allIndices(normText.text, normNeedle.text), raw.occurrence);
      if (idx !== null && normNeedle.text.length > 0) {
        start = normText.map[idx]!;
        end = normText.map[idx + normNeedle.text.length - 1]! + 1;
      }
    }

    // Pass 3 (spelling only): case-insensitive exact match.
    if (start === null && raw.type === 'spelling') {
      const idx = pickOccurrence(
        allIndices(chunkText.toLowerCase(), raw.original.toLowerCase()),
        raw.occurrence,
      );
      if (idx !== null) {
        start = idx;
        end = idx + raw.original.length;
      }
    }

    if (start === null || end === null || end <= start) continue;

    located.push({
      id: issueId(raw),
      type: raw.type,
      start,
      end,
      original: chunkText.slice(start, end),
      replacement: raw.replacement,
      explanation: raw.explanation,
    });
  }

  // Drop overlapping spans — first located wins.
  located.sort((a, b) => a.start - b.start || a.end - b.end);
  const result: IssueDto[] = [];
  let lastEnd = -1;
  for (const issue of located) {
    if (issue.start < lastEnd) continue;
    result.push(issue);
    lastEnd = issue.end;
  }
  return result;
}
