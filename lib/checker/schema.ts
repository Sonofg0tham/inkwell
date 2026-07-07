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

const rawIssueSchema = z
  .object({
    type: z.enum(['spelling', 'grammar', 'punctuation', 'style']),
    original: z.string().min(1).max(200),
    replacement: z.string().max(300),
    occurrence: z.number().int().min(1).optional(),
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

/**
 * Validates model output. Invalid items are dropped individually rather than
 * failing the whole batch. Caps at 20 issues.
 */
export function parseIssues(rawText: string): RawIssue[] {
  const obj = extractJson(rawText);
  const list = Array.isArray(obj) ? obj : (obj as { issues?: unknown })?.issues;
  if (!Array.isArray(list)) {
    throw new ProviderError('bad_response', 'The model response had no "issues" array.');
  }
  const valid: RawIssue[] = [];
  for (const item of list.slice(0, 20)) {
    const parsed = rawIssueSchema.safeParse(item);
    if (parsed.success) valid.push(parsed.data);
  }
  return valid;
}
