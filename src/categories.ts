import type { Sql } from './db.js';
import { invalidInput } from './errors.js';

/** Shapes the apps can draw (geometry in the OpenAPI `Category` description). */
export const SHAPES = ['circle', 'half', 'triangle', 'triangle_down', 'ring', 'square', 'quarter', 'house'] as const;
export type Shape = (typeof SHAPES)[number];

export const CATEGORY_ID = /^[a-z][a-z0-9_]{1,31}$/;
export const HEX_COLOR = /^#[0-9A-F]{6}$/;

/** A category's pictogram: SVG path data on a 24×24 grid (the icon library, `icons`). */
export interface CategoryIcon {
  id: string;
  path: string;
}

export interface CategoryRow {
  id: string;
  label: string;
  color: string;
  shape: Shape;
  icon: CategoryIcon | null;
  position: number;
  active: boolean;
}

/** Every category, retired ones too, in display order, with its icon's path. */
export const listCategories = async (sql: Sql): Promise<CategoryRow[]> =>
  (
    await sql<(Omit<CategoryRow, 'icon'> & { icon_id: string | null; icon_path: string | null })[]>`
      select c.id, c.label, c.color, c.shape, c.position, c.active, i.id as icon_id, i.path as icon_path
      from categories c left join icons i on i.id = c.icon
      order by c.position, c.id
    `
  ).map(({ icon_id, icon_path, ...c }) => ({ ...c, icon: icon_id ? { id: icon_id, path: icon_path! } : null }));

/** An icon id for a category: it must be in the library (null clears it). */
export async function requireIcon(sql: Sql, id: string | null | undefined): Promise<void> {
  if (!id) return;
  const [row] = await sql`select 1 from icons where id = ${id}`;
  if (!row) throw invalidInput(`Unknown icon: ${id}`);
}

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
