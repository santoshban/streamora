import { z } from 'zod';
import { badRequest } from './errors.js';

/** Parses `data` or throws a 400 listing every issue. */
export function parseOrThrow<T extends z.ZodType>(schema: T, data: unknown, what = 'request'): z.output<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest(
      `Invalid ${what}`,
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export const numericIdParams = z.object({ id: z.coerce.number().int().positive() });
export const stringIdParams = z.object({ id: z.string().min(1).max(128) });
