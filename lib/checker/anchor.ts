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
const PROTECTED_TOKEN = /(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/i;

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

/** Escapes a string for literal use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match ignoring how whitespace is distributed: models often re-wrap a span or
 * collapse a newline into a space. Returns [start, end] in the original text.
 */
function whitespaceFlexibleMatch(
  haystack: string,
  needle: string,
  occurrence: number | undefined,
): [number, number] | null {
  const tokens = needle.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null; // single token gains nothing here
  const re = new RegExp(tokens.map(escapeRe).join('\\s+'), 'gi');
  const spans: Array<[number, number]> = [];
  for (;;) {
    const m = re.exec(haystack);
    if (!m) break;
    spans.push([m.index, m.index + m[0].length]);
    re.lastIndex = m.index + 1;
  }
  if (spans.length === 0) return null;
  const n = occurrence ?? 1;
  if (n > spans.length) return null;
  return spans[n - 1]!;
}

/**
 * Keeps a replacement's capitalisation consistent with the text it replaces,
 * so a lower-cased model span can't quietly de-capitalise a sentence opener.
 */
function matchLeadingCase(matched: string, replacement: string): string {
  const m = matched[0];
  const r = replacement[0];
  if (!m || !r) return replacement;
  if (m === m.toUpperCase() && m !== m.toLowerCase() && r === r.toLowerCase()) {
    return r.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function isSentenceBoundary(text: string, start: number): boolean {
  if (start === 0) return true;
  return /(?:^|[.!?]\s+|\n\s*)$/.test(text.slice(0, start));
}

export function issueId(issue: RawIssue): string {
  return fnvHash(`${issue.type}:${issue.original}:${issue.occurrence ?? 1}:${issue.replacement}`);
}

export interface AnchorReport {
  issues: IssueDto[];
  /**
   * Issues the model reported that could NOT be placed in the text. These are
   * never guessed at, but the count is surfaced so the UI can say "the model
   * found things I couldn't locate" instead of falsely reporting all-clear.
   */
  dropped: number;
}

/**
 * Locates raw model issues in the chunk text. LLM offsets are never trusted —
 * a span must be found in the text by one of the passes below, in decreasing
 * order of strictness. Anything still unfound is dropped and counted.
 */
export function anchorIssues(
  chunkText: string,
  rawIssues: RawIssue[],
  enabledCategories: Record<IssueType, boolean>,
): AnchorReport {
  const located: IssueDto[] = [];
  let dropped = 0;

  for (const raw of rawIssues) {
    // Category and no-op filtering is the user's own configuration, not a
    // failure to understand the model — those are not counted as drops.
    if (!enabledCategories[raw.type]) continue;
    if (raw.original.trim() === '') continue;
    if (hasControlChars(raw.replacement)) continue;
    if (raw.replacement.trim() === raw.original.trim()) continue;

    // Models frequently pad the span they quote.
    const needle = raw.original.trim();

    let start: number | null = null;
    let end: number | null = null;
    let usedCaseInsensitiveFallback = false;

    // Pass 1: exact match.
    const exact = pickOccurrence(allIndices(chunkText, needle), raw.occurrence);
    if (exact !== null) {
      start = exact;
      end = exact + needle.length;
    }

    // Pass 2: typography-normalised match, mapped back to original offsets.
    if (start === null) {
      const normText = normalize(chunkText);
      const normNeedle = normalize(needle);
      const idx = pickOccurrence(allIndices(normText.text, normNeedle.text), raw.occurrence);
      if (idx !== null && normNeedle.text.length > 0) {
        start = normText.map[idx]!;
        end = normText.map[idx + normNeedle.text.length - 1]! + 1;
      }
    }

    // Pass 3: case-insensitive match. Applies to every category — a model
    // lower-casing a sentence opener must not cost the user a real fix.
    if (start === null) {
      const idx = pickOccurrence(
        allIndices(chunkText.toLowerCase(), needle.toLowerCase()),
        raw.occurrence,
      );
      if (idx !== null) {
        start = idx;
        end = idx + needle.length;
        usedCaseInsensitiveFallback = true;
      }
    }

    // Pass 4: whitespace-flexible, case-insensitive match for multi-word spans.
    if (start === null) {
      const span = whitespaceFlexibleMatch(chunkText, needle, raw.occurrence);
      if (span) {
        start = span[0];
        end = span[1];
        usedCaseInsensitiveFallback = true;
      }
    }

    if (start === null || end === null || end <= start) {
      dropped++;
      continue;
    }

    const matched = chunkText.slice(start, end);
    if (PROTECTED_TOKEN.test(matched)) continue;
    const replacement =
      usedCaseInsensitiveFallback && isSentenceBoundary(chunkText, start)
        ? matchLeadingCase(matched, raw.replacement.trim())
        : raw.replacement.trim();
    if (replacement === matched) continue; // resolved to a no-op after casing

    located.push({
      id: issueId(raw),
      type: raw.type,
      start,
      end,
      original: matched,
      replacement,
      explanation: raw.explanation,
    });
  }

  // Drop overlapping spans — first located wins.
  located.sort((a, b) => a.start - b.start || a.end - b.end);
  const issues: IssueDto[] = [];
  let lastEnd = -1;
  for (const issue of located) {
    if (issue.start < lastEnd) continue;
    issues.push(issue);
    lastEnd = issue.end;
  }
  return { issues, dropped };
}

/** Convenience wrapper for callers that only want the placed issues. */
export function locateIssues(
  chunkText: string,
  rawIssues: RawIssue[],
  enabledCategories: Record<IssueType, boolean>,
): IssueDto[] {
  return anchorIssues(chunkText, rawIssues, enabledCategories).issues;
}
