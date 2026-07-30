import { z } from 'zod';
import { ProviderError } from '../providers/types';

/** JSON Schema handed to providers that support structured output. */
export const ISSUE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['spelling', 'grammar', 'punctuation', 'style'] },
          original: { type: 'string', minLength: 1, maxLength: 200 },
          replacement: { type: 'string', maxLength: 300 },
          occurrence: { type: 'integer', minimum: 1 },
          explanation: { type: 'string', maxLength: 140 },
        },
        required: ['type', 'original', 'replacement', 'explanation'],
        additionalProperties: false,
      },
    },
  },
  required: ['issues'],
  additionalProperties: false,
};

/**
 * Keywords OpenAI's strict Structured Outputs mode rejects outright. They are
 * belt-and-braces here anyway — zod re-validates every field on the way back.
 */
const UNSUPPORTED_STRICT_KEYWORDS = [
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'pattern',
  'format',
  'default',
  'multipleOf',
  'uniqueItems',
];

/**
 * Converts a JSON Schema into the subset OpenAI accepts with `strict: true`:
 * every declared property must appear in `required`, so optional fields become
 * nullable instead. Without this the request 400s and the caller silently
 * retries with no schema at all, losing enum enforcement.
 */
export function toStrictJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const convert = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(convert);
    if (node === null || typeof node !== 'object') return node;

    const source = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      if (UNSUPPORTED_STRICT_KEYWORDS.includes(key)) continue;
      out[key] = convert(value);
    }

    const properties = out.properties as Record<string, Record<string, unknown>> | undefined;
    if (properties && typeof properties === 'object') {
      const previouslyRequired = new Set(
        Array.isArray(source.required) ? (source.required as string[]) : [],
      );
      for (const [name, prop] of Object.entries(properties)) {
        if (previouslyRequired.has(name)) continue;
        // Was optional; strict mode has no optional, so allow null.
        const type = prop.type;
        if (typeof type === 'string' && type !== 'null') {
          prop.type = [type, 'null'];
        }
      }
      out.required = Object.keys(properties);
      out.additionalProperties = false;
    }
    return out;
  };

  return convert(schema) as Record<string, unknown>;
}

const ISSUE_TYPES = ['spelling', 'grammar', 'punctuation', 'style'] as const;

/**
 * Repairs the `type` field before validation. Without schema enforcement
 * (json_object providers — Gemini in production, LM Studio locally) models
 * routinely omit `type` or invent categories like "clarity". A correction
 * without a category is still a correction; rejecting it costs the user a
 * real fix, so infer or remap instead:
 * - missing/empty → spelling for single-word swaps, grammar otherwise
 * - present but unrecognised → style (inventions are style-flavoured)
 */
function repairIssueType(item: unknown): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const o = { ...(item as Record<string, unknown>) };
  const t = typeof o.type === 'string' ? o.type.trim().toLowerCase() : '';
  if ((ISSUE_TYPES as readonly string[]).includes(t)) return o;
  if (t === '') {
    const orig = typeof o.original === 'string' ? o.original.trim() : '';
    const repl = typeof o.replacement === 'string' ? o.replacement.trim() : '';
    o.type =
      orig !== '' && repl !== '' && !orig.includes(' ') && !repl.includes(' ')
        ? 'spelling'
        : 'grammar';
  } else {
    o.type = 'style';
  }
  return o;
}

const rawIssueSchema = z
  .object({
    // Models commonly return "Grammar" or " spelling ".
    type: z.preprocess(
      (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
      z.enum(ISSUE_TYPES),
    ),
    original: z.string().min(1).max(200),
    replacement: z.string().max(300),
    // Strict schemas send null for "not applicable"; some models send "2".
    occurrence: z.preprocess(
      (v) => {
        if (v === null || v === undefined || v === '') return undefined;
        if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
        return v;
      },
      z.number().int().min(1).optional(),
    ),
    explanation: z
      .string()
      .optional()
      .default('')
      .transform((s) => s.slice(0, 140)),
  })
  .strip();

export type RawIssue = z.infer<typeof rawIssueSchema>;

/**
 * Extracts a JSON object from raw model text: strips markdown fences, slices
 * first "{" to last "}", and attempts one trailing-comma repair pass.
 * Model output is untrusted input — throws ProviderError on failure.
 */
export function extractJson(raw: string): unknown {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new ProviderError('bad_response', 'The model did not return JSON.');
  }
  text = text.slice(first, last + 1);
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(text.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      throw new ProviderError('bad_response', 'The model returned JSON that could not be parsed.');
    }
  }
}

export interface ParseReport {
  issues: RawIssue[];
  /**
   * Items the model returned that failed validation. Counted, never hidden:
   * an unreported drop is indistinguishable from "your writing is fine".
   */
  rejected: number;
  /**
   * Deduplicated, human-readable reasons for those rejections. Field paths and
   * validator messages only — never the user's own text.
   */
  reasons: string[];
}

/** Summarises which fields a model got wrong, without echoing user content. */
function describeFailure(item: unknown, error: z.ZodError): string {
  const parts = error.issues.map((i) => {
    const field = i.path.join('.') || '(root)';
    if (i.code === 'invalid_type' && (i as { received?: string }).received === 'undefined') {
      return `${field} is missing`;
    }
    return `${field}: ${i.message}`;
  });
  const keys =
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.keys(item as Record<string, unknown>).join(', ')
      : typeof item;
  return `${parts.join('; ')} [model sent keys: ${keys}]`;
}

/**
 * Validates model output. Invalid items are dropped individually rather than
 * failing the whole batch, but the drops are counted and logged so a model
 * that fails validation systematically cannot masquerade as a clean result.
 * Caps at 20 issues.
 */
export function parseIssuesDetailed(rawText: string): ParseReport {
  const obj = extractJson(rawText);
  const list = Array.isArray(obj) ? obj : (obj as { issues?: unknown })?.issues;
  if (!Array.isArray(list)) {
    throw new ProviderError('bad_response', 'The model response had no "issues" array.');
  }
  const issues: RawIssue[] = [];
  const problems: string[] = [];
  const overflow = Math.max(0, list.length - 20);
  for (const item of list.slice(0, 20)) {
    const parsed = rawIssueSchema.safeParse(repairIssueType(item));
    if (parsed.success) issues.push(parsed.data);
    else problems.push(describeFailure(item, parsed.error));
  }
  // Deduplicate: a systematically wrong model repeats the same mistake.
  const overflowReason = `${overflow} additional issues exceeded the per-response limit`;
  const reasons = [
    ...(overflow > 0 ? [overflowReason] : []),
    ...new Set(problems),
  ].slice(0, 3);
  const rejected = problems.length + overflow;
  if (rejected > 0) {
    // Joined into the message itself — an object argument collapses to
    // "Array(2)" in the console and hides the very detail that explains this.
    console.warn(
      `[Inkwell] ignored ${rejected} issue(s) from the model — ${reasons.join(' | ')}`,
    );
  }
  return { issues, rejected, reasons };
}

/** Convenience wrapper for callers that only want the valid issues. */
export function parseIssues(rawText: string): RawIssue[] {
  return parseIssuesDetailed(rawText).issues;
}
