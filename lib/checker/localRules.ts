import type { IssueDto, IssueType } from '../messaging/protocol';
import type { Settings } from '../settings/schema';
import { fnvHash } from './hash';

interface TextRange {
  start: number;
  end: number;
}

// URLs, email addresses and inline code are never prose.
const LITERAL_PATTERNS = [
  /(?:https?:\/\/|www\.)[^\s<>"']+/giu,
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu,
  /`[^`\r\n]*`/g,
] as const;
// Dotted identifiers such as node.js or Array.from().
const IDENTIFIER_PATTERN = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\([^\r\n)]*\))?/g;

function protectedRanges(text: string, patterns: readonly RegExp[]): TextRange[] {
  const ranges: TextRange[] = [];
  for (const pattern of patterns) {
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

// Letters, digits and apostrophes that continue a word. JavaScript's \b is
// ASCII-only, so these lookarounds give Unicode-aware word edges.
const WORD_BEFORE = String.raw`(?<![\p{L}\p{N}'’])`;
const WORD_AFTER = String.raw`(?![\p{L}\p{N}'’])`;

function wordPattern(source: string, flags = 'giu'): RegExp {
  return new RegExp(`${WORD_BEFORE}(?:${source})${WORD_AFTER}`, flags);
}

// Repeats that are correct English ("that that", "had had") or deliberate.
export const ALLOWED_REPEATS: ReadonlySet<string> = new Set([
  'that', 'had', 'bye', 'very', 'so', 'really', 'ha', 'haha', 'no', 'yeah', 'yes',
  'knock', 'blah', 'now', 'there', 'well', 'far', 'more', 'many', 'much', 'again',
  'tut', 'tsk', 'chop', 'hush', 'aye', 'oh', 'ah', 'la', 'go', 'boo', 'ho', 'hip',
  'pom', 'cha', 'din', 'dum', 'tick', 'tock', 'ding', 'dong', 'night', 'wait',
]);

// Words after which a full stop does not end a sentence.
const ABBREVIATIONS = new Set([
  'etc', 'vs', 'mr', 'mrs', 'ms', 'dr', 'st', 'no', 'nos', 'fig', 'figs', 'approx',
  'dept', 'est', 'inc', 'ltd', 'co', 'jr', 'sr', 'prof', 'gen', 'gov', 'govt', 'vol',
  'ch', 'sec', 'pp', 'ed', 'eds', 'rev', 'op', 'cf', 'al', 'jan', 'feb', 'mar', 'apr',
  'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'mon', 'tue', 'tues', 'wed',
  'thu', 'thur', 'thurs', 'fri', 'sat', 'sun', 'ave', 'rd', 'misc', 'min', 'max', 'hr',
  'hrs', 'wk', 'mins', 'corp', 'assn', 'bros', 'ref', 'tel', 'ext', 'univ',
]);

// Ordinary words that often open a sentence. Capitalising only these keeps
// lowercase product names, commands and usernames ("npm", "zx") untouched.
const SENTENCE_STARTERS = new Set([
  'the', 'a', 'an', 'it', 'its', "it's", 'this', 'that', 'these', 'those', 'we', "we're",
  "we've", "we'll", 'they', "they're", "they've", "they'll", 'he', "he's", 'she', "she's",
  'you', "you're", "you've", "you'll", 'there', "there's", 'here', "here's", 'my', 'our',
  'your', 'his', 'her', 'their', 'but', 'and', 'so', 'or', 'if', 'when', 'while', 'then',
  'also', 'however', 'what', "what's", 'why', 'how', 'where', 'who', 'which', 'please',
  'thanks', 'thank', 'yes', 'no', 'ok', 'okay', 'now', 'just', 'maybe', 'perhaps', 'let',
  "let's", 'can', 'could', 'would', 'should', 'will', 'do', 'does', 'did', "don't",
  "doesn't", "didn't", 'is', 'are', 'was', 'were', 'have', 'has', 'had', 'not', 'in', 'on',
  'at', 'for', 'with', 'after', 'before', 'as', 'one', 'all', 'some', 'many', 'most',
  'every', 'each', 'both', 'once', 'since', 'because', 'although', 'though', 'unfortunately',
  'hopefully', 'actually', 'anyway', 'still', 'even', 'only', 'today', 'tomorrow',
  'yesterday', 'sorry', 'hi', 'hello', 'great', 'good', 'sure', 'well', 'otherwise', 'next',
  'finally', 'first', 'again', 'meanwhile', 'instead', 'similarly', 'overall',
]);

// "a" before these vowel-letter words is correct because of how they sound.
const A_BEFORE_VOWEL_OK = /^(?:one|once|onesie|eu|ewe|ouija)/iu;
// Words too short or too common to judge as the next word after "a".
const A_NEXT_WORD_SKIP = new Set([
  'or', 'and', 'an', 'as', 'at', 'is', 'it', 'in', 'on', 'of', 'if', 'are', 'also',
  'every', 'each', 'ok', 'okay', 'i',
]);
const SILENT_H = /^(?:hour|hours|hourly|honest|honestly|honesty|honour|honours|honourable|honor|honors|honorable|heir|heirs|heiress)$/iu;
const CONSONANT_SOUND_U = /^(?:unique|university|universities|universal|user|users|useful|usual|usually|union|unions|uniform|unit|units|united|utility|usage|unicorn|euro|euros|european|one|once)$/iu;
const COMPARATIVES =
  'better|worse|more|less|greater|bigger|smaller|larger|faster|slower|higher|lower|taller|shorter|older|younger|cheaper|easier|harder|stronger|weaker|richer|poorer|other';
// Comparatives and superlatives that never take "more" or "most" as well.
const ER_FORMS =
  'better|worse|bigger|smaller|smarter|faster|slower|easier|harder|happier|taller|shorter|older|younger|cheaper|stronger|weaker|richer|poorer|larger|greater|higher|longer|quicker|nicer|safer|simpler|louder|quieter|warmer|colder|hotter|wider|deeper|heavier|busier|funnier|prettier|healthier|friendlier|luckier|newer';
const EST_FORMS =
  'best|worst|biggest|smallest|smartest|fastest|slowest|easiest|hardest|happiest|tallest|shortest|oldest|youngest|cheapest|strongest|weakest|richest|poorest|largest|greatest|highest|longest|quickest|nicest|safest|simplest|loudest|quietest|warmest|coldest|hottest|widest|deepest|heaviest|busiest|funniest|prettiest|healthiest|friendliest|luckiest|newest|kindest';
// Plural nouns that are always counted, so take "fewer" rather than "less".
const COUNT_NOUNS =
  'people|friends|things|items|words|mistakes|errors|cars|days|weeks|months|years|hours|minutes|times|calories|questions|options|choices|students|children|members|employees|jobs|problems|issues|emails|messages|books|games|players|customers|users|visitors|cases|bugs|steps|pages';
const LEND_FORMS: Readonly<Record<string, string>> = {
  borrow: 'lend',
  borrows: 'lends',
  borrowed: 'lent',
  borrowing: 'lending',
};
const SUBJECT_FORMS: Readonly<Record<string, string>> = { him: 'He', her: 'She', them: 'They' };
const SENTENCE_START = String.raw`(?:^|(?<=[.!?]\s+|\n))`;
// "Me and him" or "Him and me" used as the subject of a sentence.
const OBJECT_PAIR = String.raw`Me\s+and\s+(?:him|her|them|\p{Lu}\p{Ll}+)|(?:Him|Her|Them)\s+and\s+me`;
const SUBJECT_VERBS =
  'was|were|are|is|went|have|had|has|will|would|can|could|should|did|do|got|go|made|saw|met|played|left|came|walked|bought|found|took';

/**
 * Rules for mistakes that can be corrected without guessing at the writer's
 * meaning. Every rule here runs offline on each pause in typing, so each one
 * is written to stay silent on correct English (see tests/localCorpus.test.ts).
 * Context-heavy grammar stays with the model.
 */
export function findLocalRuleIssues(text: string, settings: Settings): IssueDto[] {
  const literalText = protectedRanges(text, LITERAL_PATTERNS);
  const protectedText = [...literalText, ...protectedRanges(text, [IDENTIFIER_PATTERN])];
  const issues: IssueDto[] = [];
  const add = (issue: IssueDto, ranges: TextRange[] = protectedText): void => {
    if (overlapsProtected(issue.start, issue.end, ranges)) return;
    if (issues.some((current) => current.start < issue.end && issue.start < current.end)) return;
    issues.push(issue);
  };
  /** Flags capture group 1 of each match, or the whole match if there is none. */
  const each = (
    type: IssueType,
    pattern: RegExp,
    replace: (original: string, match: RegExpMatchArray) => string | null,
    explanation: string,
  ): void => {
    const withIndices = new RegExp(pattern.source, `${pattern.flags}d`);
    for (const match of text.matchAll(withIndices)) {
      const original = match[1] ?? match[0];
      const offset = match.indices?.[1] ? match.indices[1][0] - match.index : 0;
      const replacement = replace(original, match);
      if (replacement === null || replacement === original) continue;
      add(makeIssue(type, original, replacement, match.index + offset, explanation));
    }
  };

  if (settings.categories.grammar) {
    each('grammar', wordPattern(String.raw`(their)(?=\s+(?:is|are|was|were|seems?|appears?)${WORD_AFTER})`), () => 'there',
      'Use “there” in this construction.');
    each('grammar', wordPattern(String.raw`(your)(?=\s+(?:welcome\s*(?:[.!,;]|$)|welcome\s+to\s+(?!(?:the|our|my|this|your|their)${WORD_AFTER})|(?:going\s+to|gonna|not)${WORD_AFTER}))`),
      () => "you're", 'Use the contraction for “you are”.');
    // A possessive never comes straight before an article: "Your the best".
    each('grammar', new RegExp(String.raw`${WORD_BEFORE}([yY]our)(?=\s+(?:the|an?)\s+\p{L})`, 'gu'),
      () => "you're", 'Use the contraction for “you are”.');
    each('grammar', wordPattern(String.raw`(their)(?=\s+(?:going\s+to|gonna)${WORD_AFTER})`), () => "they're",
      'Use the contraction for “they are”.');
    each('grammar', wordPattern(String.raw`(?:could|should|would|might|must)\s+(of)`), () => 'have',
      'Use “have” after a modal verb.');

    // The pronoun I, including its contractions. "(i)" list markers and
    // "i.e." are left alone.
    each('grammar', new RegExp(String.raw`(?<![\p{L}\p{N}'’.(\-])i(?:['’](?:m|ve|ll|d))?(?![\p{L}\p{N}'’.)\-])`, 'gu'),
      (original) => 'I' + original.slice(1), 'Always capitalise the pronoun “I”.');

    // Repeated words.
    for (const match of text.matchAll(new RegExp(String.raw`${WORD_BEFORE}(\p{L}+)(?=([ \t]+)(\p{L}+)${WORD_AFTER})`, 'gu'))) {
      const [, first, space, second] = match as unknown as [string, string, string, string];
      const whole = first + space + second;
      const lower = first.toLocaleLowerCase('en');
      if (lower !== second.toLocaleLowerCase('en') || ALLOWED_REPEATS.has(lower)) continue;
      if (lower === 'is' && /(?:^|[^\p{L}])(?:what|which|how|where|who)\s+(?:it|this|that)\s+$/iu.test(text.slice(0, match.index))) continue;
      add(makeIssue('grammar', whole, first, match.index, 'Remove the repeated word.'));
    }

    // "its" where "it is" or "it has" is meant, and the reverse.
    each('grammar', wordPattern(String.raw`(its)(?=\s+(?:been|a|an|not|going|gonna|important|also|still|just|really|very|so|too|always|never|true|clear|hard|easy|possible|likely|ok|okay|fine|great|nice|raining|getting)${WORD_AFTER})`),
      () => "it's", 'Use “it’s” for “it is” or “it has”.');
    each('grammar', wordPattern(String.raw`(it['’]s)(?=\s+own${WORD_AFTER})`), () => 'its',
      'Use “its” for something that belongs to it.');
    each('grammar', wordPattern(String.raw`(?:of|with|into|changed|lost|reached|improved|wagged|raised|doubled|increased|reduced|updated|lowered)\s+(it['’]s)(?=\s+\p{L})`),
      () => 'its', 'Use “its” for something that belongs to it.');

    // Articles. Acronyms, letters and numbers are skipped because they are
    // read aloud letter by letter ("an MP", "a URL").
    each('grammar', wordPattern(String.raw`([aA])\s+(\p{Ll}[\p{L}'’]*)(?![\p{L}\p{N}'’-])`, 'gu'), (original, match) => {
      const next = match[2]!;
      if (A_NEXT_WORD_SKIP.has(next.toLocaleLowerCase('en'))) return null;
      if (SILENT_H.test(next)) return 'an';
      return /^[aeio]/iu.test(next) && !A_BEFORE_VOWEL_OK.test(next) ? 'an' : null;
    }, 'Use “an” before a vowel sound.');
    each('grammar', wordPattern(String.raw`([aA]n)\s+(\p{Ll}[\p{L}'’]*)(?![\p{L}\p{N}'’-])`, 'gu'), (original, match) => {
      const next = match[2]!;
      if (CONSONANT_SOUND_U.test(next)) return 'a';
      return /^[b-df-gj-np-tv-z]/iu.test(next) ? 'a' : null;
    }, 'Use “a” before a consonant sound.');

    // Subject-verb agreement that never depends on meaning.
    each('grammar', wordPattern(String.raw`(?:he|she|it)\s+(don['’]t|dont)`), () => "doesn't",
      'Use “doesn’t” with he, she or it.');
    each('grammar', wordPattern(String.raw`(?:I|you|we|they)\s+(doesn['’]t|doesnt)`), () => "don't",
      'Use “don’t” with I, you, we or they.');
    each('grammar', wordPattern(String.raw`(?:we|they|you)\s+(was)`), () => 'were',
      'Use “were” with we, you or they.');
    // "Me and him went" at the start of a sentence: the subject takes "I",
    // which goes last, and two people take "were".
    each('grammar', new RegExp(String.raw`${SENTENCE_START}(${OBJECT_PAIR})(?=\s+(?:${SUBJECT_VERBS})${WORD_AFTER})`, 'gu'),
      (original) => {
        const words = original.split(/\s+/u);
        const other = words[0]!.toLocaleLowerCase('en') === 'me' ? words[2]! : words[0]!;
        return `${SUBJECT_FORMS[other.toLocaleLowerCase('en')] ?? other} and I`;
      }, 'Use “I” as part of the subject, and put yourself last.');
    each('grammar', new RegExp(String.raw`${SENTENCE_START}(?:${OBJECT_PAIR}|(?:He|She|They|\p{Lu}\p{Ll}+)\s+and\s+I)\s+(was)${WORD_AFTER}`, 'gu'),
      () => 'were', 'Use “were” with two or more people.');

    // "more smarter", "most best".
    each('grammar', wordPattern(String.raw`(more\s+(?:${ER_FORMS})(?=\s+(?:than|to)${WORD_AFTER}|\s*[.,;:!?]|\s*$)|most\s+(?:${EST_FORMS})(?!-))`),
      (original) => original.split(/\s+/u).at(-1)!, 'Use “more” or the “-er” form, not both.');
    each('grammar', wordPattern(String.raw`(?<!(?:or|no|much)\s+)(less)(?=\s+(?:${COUNT_NOUNS})${WORD_AFTER}(?!-))`),
      () => 'fewer', 'Use “fewer” for things you can count.');
    each('grammar', wordPattern(String.raw`(borrow(?:s|ed|ing)?)(?=\s+(?:me|him|her|us|them)\s+(?:a|an|the|some|any|my|your|his|her|our|their|this|that|\p{N}+)${WORD_AFTER})`),
      (original) => LEND_FORMS[original.toLocaleLowerCase('en')] ?? null,
      'Use “lend” for giving something to someone.');

    // Common confusions with a fixed, unambiguous context.
    each('grammar', wordPattern(String.raw`(?:${COMPARATIVES})\s+(then)(?=\s+\p{L})(?!\s+(?:${COMPARATIVES}|again|later|after|before\s+\p{L}))`),
      () => 'than', 'Use “than” to make a comparison.');
    each('grammar', wordPattern(String.raw`rather\s+\p{L}+\s+(then)(?=\s+\p{L})`), () => 'than',
      'Use “than” to make a comparison.');
    each('grammar', wordPattern(String.raw`(?:to|could|would|should|will|might|may|must|can|cannot|can['’]t|won['’]t|don['’]t|didn['’]t)\s+(loose)`),
      () => 'lose', 'Use “lose” for misplacing or failing to win something.');
    each('grammar', wordPattern(String.raw`(?:are|is|am|was|were|be|been|keep|kept|stop|start|started)\s+(loosing)`),
      () => 'losing', 'Use “losing” for misplacing or failing to win something.');
    each('grammar', wordPattern(String.raw`side\s+(affects?)`), (original) => original.replace(/^a/iu, 'e'),
      'Use “effect” for a result.');
    each('grammar', wordPattern(String.raw`(?:a|an|the|no|any|big|huge|great|positive|negative|lasting|real|significant|major|minor|little|small|direct|bad|good|strong)\s+(affect)(?=\s+(?:on|of)${WORD_AFTER})`),
      () => 'effect', 'Use “effect” for a result.');
    each('grammar', new RegExp(String.raw`(?:^|(?<=[.!?]\s+|\n))(lets)(?=\s+(?:go|do|see|try|get|make|have|be|start|talk|meet|eat|play|hope|say|keep|take|find|look|move|begin|wait|work)${WORD_AFTER})`, 'giu'),
      () => "let's", 'Use “let’s” for “let us”.');

    // A lowercase word that starts a new sentence.
    for (const match of text.matchAll(/(?<![\p{L}\p{N}])([\p{L}\p{N}]+)([.!?])(["'’”)]?)(\s+)(\p{Ll}[\p{Ll}'’]*)(?![\p{L}\p{N}])/gu)) {
      const [, previous, mark, , space, word] = match as unknown as [string, string, string, string, string, string];
      const previousStart = match.index;
      if (mark === '.') {
        if (previous.length === 1 || ABBREVIATIONS.has(previous.toLocaleLowerCase('en'))) continue;
        if (previousStart > 0 && text[previousStart - 1] === '.') continue;
      }
      if (!SENTENCE_STARTERS.has(word.replaceAll('’', "'"))) continue;
      const wordStart = match.index + match[0].length - word.length;
      if (space.includes('\n') && !/^\s*\n\s*$/u.test(space)) continue;
      add(makeIssue('grammar', word, word[0]!.toLocaleUpperCase('en') + word.slice(1), wordStart,
        'Start a new sentence with a capital letter.'));
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
    for (const match of text.matchAll(/(?<=\p{L})[ ]{2,}(?=\p{L})/gu)) {
      add(makeIssue('punctuation', match[0], ' ', match.index, 'Use a single space between words.'));
    }
    // "word.Word" with no space. The identifier pattern would protect this
    // span, so only URLs, email addresses and inline code are honoured here.
    for (const match of text.matchAll(/(?<![\p{L}\p{N}.])(\p{Ll}{2,})\.(\p{Lu}\p{Ll}+)(?=[\s,;:!?]|\.(?!\p{L})|$)/gu)) {
      add(makeIssue('punctuation', match[0], `${match[1]}. ${match[2]}`, match.index,
        'Add a space after the full stop.'), literalText);
    }
  }

  return issues.sort((left, right) => left.start - right.start || left.end - right.end);
}
