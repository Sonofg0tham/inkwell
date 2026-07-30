import type { IssueDto, IssueType } from '../messaging/protocol';
import type { Settings } from '../settings/schema';
import { fnvHash } from './hash';

interface TextRange {
  start: number;
  end: number;
}

const PROTECTED_PATTERNS = [
  /(?:https?:\/\/|www\.)[^\s<>"']+/giu,
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu,
  /`[^`\r\n]*`/g,
  /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\([^\r\n)]*\))?/g,
] as const;

function protectedRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  for (const pattern of PROTECTED_PATTERNS) {
    pattern.lastIndex = 0;
    for (;;) {
      const match = pattern.exec(text);
      if (!match) break;
      ranges.push({ start: match.index, end: match.index + match[0].length });
      if (match[0].length === 0) pattern.lastIndex++;
    }
  }
  return ranges;
}

function overlapsProtected(start: number, end: number, ranges: TextRange[]): boolean {
  return ranges.some((range) => start < range.end && range.start < end);
}

function matchCase(original: string, replacement: string): string {
  const first = original[0];
  if (first && first === first.toLocaleUpperCase('en')) {
    return replacement[0]!.toLocaleUpperCase('en') + replacement.slice(1);
  }
  return replacement;
}

function makeIssue(
  type: IssueType,
  original: string,
  replacement: string,
  start: number,
  explanation: string,
): IssueDto {
  return {
    id: fnvHash(`${type}:${original}:${start}:${replacement}`),
    type,
    start,
    end: start + original.length,
    original,
    replacement: matchCase(original, replacement),
    explanation,
  };
}

/**
 * A deliberately small rule set for mistakes that can be corrected without
 * guessing at the writer's meaning. Context-heavy grammar stays with the LLM.
 */
export function findLocalRuleIssues(text: string, settings: Settings): IssueDto[] {
  const protectedText = protectedRanges(text);
  const issues: IssueDto[] = [];
  const add = (issue: IssueDto): void => {
    if (overlapsProtected(issue.start, issue.end, protectedText)) return;
    if (issues.some((current) => current.start < issue.end && issue.start < current.end)) return;
    issues.push(issue);
  };

  if (settings.categories.grammar) {
    for (const match of text.matchAll(/\btheir(?=\s+(?:is|are|was|were|seems?|appears?)\b)/giu)) {
      add(makeIssue('grammar', match[0], 'there', match.index, 'Use “there” in this construction.'));
    }
    for (const match of text.matchAll(/\byour(?=\s+welcome\b)/giu)) {
      add(makeIssue('grammar', match[0], "you're", match.index, 'Use the contraction for “you are”.'));
    }
    for (const match of text.matchAll(/\b(?:could|should|would|might|must)\s+(of)\b/giu)) {
      const original = match[1]!;
      const start = match.index + match[0].lastIndexOf(original);
      add(makeIssue('grammar', original, 'have', start, 'Use “have” after a modal verb.'));
    }
  }

  if (settings.categories.punctuation) {
    for (const match of text.matchAll(/[ \t]+[,.;:!?]/g)) {
      add(makeIssue(
        'punctuation',
        match[0],
        match[0].trimStart(),
        match.index,
        'Remove the space before the punctuation mark.',
      ));
    }
  }

  return issues.sort((left, right) => left.start - right.start || left.end - right.end);
}
