import type { Context } from 'hono';
import { z } from 'zod';
import { toFieldIssues, ValidationError } from '@morrow/core';
import { badRequest } from './errors';

/** Read and validate a JSON body. Missing bodies validate as `{}`. */
export async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown = {};
  const text = await c.req.text();
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw badRequest('The request body is not valid JSON.');
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = toFieldIssues(parsed.error.issues);
    throw new ValidationError(issues[0] ? `${issues[0].path || 'body'}: ${issues[0].message}` : 'Invalid request body.', issues);
  }
  return parsed.data;
}

/** Validate query-string parameters (all values arrive as strings). */
export function readQuery<T extends z.ZodType>(c: Context, schema: T): z.infer<T> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    const issues = toFieldIssues(parsed.error.issues);
    throw new ValidationError(issues[0] ? `${issues[0].path}: ${issues[0].message}` : 'Invalid query parameters.', issues);
  }
  return parsed.data;
}

// ---------------------------------------------------------------- shared shapes

export const pageQuery = {
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
};

export const queryBool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes')
  .optional();

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

export const rangeQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() });

/** Comma-separated list in a query string. */
export const csvList = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .optional();

export const idList = z.array(z.string().min(1).max(64)).max(1000);

/** Free-form object; the service layer performs full validation. */
export const anyObject = z.record(z.string(), z.unknown());
