import type { Sql } from './db.js';
import { invalidInput } from './errors.js';

/** Shapes the apps can draw (geometry in the OpenAPI `Category` description). */
export const SHAPES = ['circle', 'half', 'triangle', 'triangle_down', 'ring', 'square', 'quarter', 'house'] as const;
export type Shape = (typeof SHAPES)[number];

export const CATEGORY_ID = /^[a-z][a-z0-9_]{1,31}$/;
export const HEX_COLOR = /^#[0-9A-F]{6}$/;

export interface CategoryRow {
  id: string;
  label: string;
  color: string;
  shape: Shape;
  position: number;
  active: boolean;
}

/** Every category, retired ones too, in display order. */
export const listCategories = (sql: Sql) =>
  sql<CategoryRow[]>`select id, label, color, shape, position, active from categories order by position, id`;

/** For new places and new category choices: the category must exist and not be retired. */
export async function requireActiveCategory(sql: Sql, id: string): Promise<void> {
  const [row] = await sql<{ active: boolean }[]>`select active from categories where id = ${id}`;
  if (!row) throw invalidInput(`Unknown category: ${id}`);
  if (!row.active) throw invalidInput(`Category ${id} is retired`);
}

/** For lists that may keep retired categories (favourites): they must exist. */
export async function requireCategories(sql: Sql, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const found = await sql<{ id: string }[]>`select id from categories where id = any(${ids})`;
  const missing = ids.filter((id) => !found.some((f) => f.id === id));
  if (missing.length) throw invalidInput(`Unknown categories: ${missing.join(', ')}`);
}
