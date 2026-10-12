import { z } from 'zod';
import { invalidInput } from './errors.js';

/** Query parameters for cursor pagination. The cursor is opaque to clients: pass back `next_cursor`. */
export const pagingQuery = (maxLimit = 100) => ({
  limit: z.coerce.number().int().min(1).max(maxLimit).default(30),
  cursor: z.string().max(200).optional().meta({ description: '`next_cursor` from the previous page' }),
});

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const { o } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o: unknown };
    if (typeof o === 'number' && Number.isInteger(o) && o >= 0) return o;
  } catch {
    // fall through
  }
  throw invalidInput('Invalid cursor');
}

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');

/** `{ items, next_cursor, total }` for a page that started at `offset`. */
export function page<T>(items: T[], offset: number, total: number) {
  const next = offset + items.length;
  return { items, next_cursor: items.length && next < total ? encodeCursor(next) : null, total };
}
