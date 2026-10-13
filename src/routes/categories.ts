import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import { CATEGORY_ID, HEX_COLOR, requireIcon, SHAPES } from '../categories.js';
import { HttpError, invalidInput, notFound } from '../errors.js';
import { AdminCategory, AdminCategoryList } from '../schemas.js';

const label = z.string().trim().min(1).max(40);
const color = z
  .string()
  .transform((c) => c.toUpperCase())
  .pipe(z.string().regex(HEX_COLOR, 'expected #RRGGBB'));
const shape = z.enum(SHAPES);
const icon = z.string().nullable().meta({ description: 'An icon id from the library (/admin/icons); null = none' });
const idParams = z.object({ id: z.string().regex(CATEGORY_ID) });

interface Row {
  id: string;
  label: string;
  color: string;
  shape: (typeof SHAPES)[number];
  icon_id: string | null;
  icon_path: string | null;
  position: number;
  active: boolean;
  updated_at: Date;
  user_id: string | null;
  user_name: string | null;
  places: number;
}

/** Category management for admins. Clients read the result from GET /meta (`category_details`). */
export function categoryRoutes(app: App, ctx: Ctx) {
  const { sql } = ctx;

  const select = (where = sql`true`) => sql<Row[]>`
    select c.id, c.label, c.color, c.shape, c.position, c.active, c.updated_at,
           i.id as icon_id, i.path as icon_path,
           u.id as user_id, u.name as user_name,
           (select count(*)::int from places p where p.category = c.id) as places
    from categories c left join users u on u.id = c.updated_by left join icons i on i.id = c.icon
    where ${where}
    order by c.position, c.id
  `;

  const toCategory = (r: Row) => ({
    id: r.id,
    label: r.label,
    color: r.color,
    shape: r.shape,
    icon: r.icon_id ? { id: r.icon_id, path: r.icon_path! } : null,
    position: r.position,
    active: r.active,
    places: r.places,
    updated_at: r.updated_at.toISOString(),
    updated_by: r.user_id ? { id: r.user_id, display_name: r.user_name! } : null,
  });

  async function load(id: string) {
    const [row] = await select(sql`c.id = ${id}`);
    if (!row) throw notFound('Category');
    return toCategory(row);
  }

  /** Two categories with the same name would be indistinguishable in the apps. */
  async function requireFreeLabel(text: string, except?: string) {
    const [taken] = await sql`
      select id from categories where lower(label) = lower(${text}) and id is distinct from ${except ?? null}
    `;
    if (taken) throw new HttpError(409, 'category_exists', `A category named ${text} already exists`);
  }

  /** At least one category must stay open for new places. */
  async function requireAnotherActive(id: string) {
    const [other] = await sql`select 1 from categories where active and id <> ${id}`;
    if (!other) throw new HttpError(409, 'last_category', 'At least one category must stay active');
  }

  app.get(
    '/admin/categories',
    {
      preHandler: ctx.admin,
      schema: {
        tags: ['Admin'],
        summary: 'Categories',
        description: 'Every category with its number of places, in display order.',
        response: { 200: AdminCategoryList },
      },
    },
    async () => ({ items: (await select()).map(toCategory) }),
  );

  app.post(
    '/admin/categories',
    {
      preHandler: ctx.admin,
      schema: {
        tags: ['Admin'],
        summary: 'Add a category',
        description:
          'Added at the end of the list, active. The id is permanent (places refer to it): lowercase letters, ' +
          'digits and `_`, 2–32 characters. `icon`: an id from the icon library (optional). 409 `category_exists` ' +
          'when the id or the name is taken.',
        body: z.object({ id: idParams.shape.id, label, color, shape, icon: icon.optional() }),
        response: { 201: AdminCategory },
      },
    },
    async (req, reply) => {
      const b = req.body;
      await requireFreeLabel(b.label);
      await requireIcon(sql, b.icon);
      const [inserted] = await sql`
        insert into categories (id, label, color, shape, icon, position, updated_by)
        values (${b.id}, ${b.label}, ${b.color}, ${b.shape}, ${b.icon ?? null},
                (select coalesce(max(position), 0) + 1 from categories), ${req.user.id})
        on conflict (id) do nothing
        returning id
      `;
      if (!inserted) throw new HttpError(409, 'category_exists', `Category ${b.id} already exists`);
      return reply.status(201).send(await load(b.id));
    },
  );

  app.patch(
    '/admin/categories/:id',
    {
      preHandler: ctx.admin,
      schema: {
        tags: ['Admin'],
        summary: 'Change a category',
        description:
          'Name, colour, shape, icon (null clears it), or `active`: retiring a category keeps its places but stops it being offered ' +
          'for new ones. 409 `category_exists`, `last_category`.',
        params: idParams,
        body: z.object({
          label: label.optional(),
          color: color.optional(),
          shape: shape.optional(),
          icon: icon.optional(),
          active: z.boolean().optional(),
        }),
        response: { 200: AdminCategory },
      },
    },
    async (req) => {
      const { id } = req.params;
      const b = req.body;
      await load(id);
      if (b.label !== undefined) await requireFreeLabel(b.label, id);
      if (b.active === false) await requireAnotherActive(id);
      await requireIcon(sql, b.icon);
      const set: Record<string, unknown> = {};
      for (const key of ['label', 'color', 'shape', 'icon', 'active'] as const)
        if (b[key] !== undefined) set[key] = b[key];
      if (Object.keys(set).length) {
        await sql`update categories set ${sql(set)}, updated_at = now(), updated_by = ${req.user.id} where id = ${id}`;
      }
      return load(id);
    },
  );

  app.put(
    '/admin/categories/order',
    {
      preHandler: ctx.admin,
      schema: {
        tags: ['Admin'],
        summary: 'Reorder the categories',
        description: 'Every category id once, in the new display order. 422 `invalid_input` otherwise.',
        body: z.object({ ids: z.array(idParams.shape.id) }),
        response: { 200: AdminCategoryList },
      },
    },
    async (req) => {
      const { ids } = req.body;
      const all = await sql<{ id: string }[]>`select id from categories`;
      if (ids.length !== all.length || new Set(ids).size !== ids.length || !all.every((c) => ids.includes(c.id))) {
        throw invalidInput('Send every category id exactly once');
      }
      await sql.begin(async (tx) => {
        for (const [i, id] of ids.entries()) await tx`update categories set position = ${i + 1} where id = ${id}`;
      });
      return { items: (await select()).map(toCategory) };
    },
  );

  app.delete(
    '/admin/categories/:id',
    {
      preHandler: ctx.admin,
      schema: {
        tags: ['Admin'],
        summary: 'Delete a category',
        description:
          'Only a category without places (409 `category_in_use` with `places`; retire it instead). ' +
          'It is also removed from people’s favourite categories. 409 `last_category`.',
        params: idParams,
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const category = await load(id);
      if (category.places > 0) {
        throw new HttpError(409, 'category_in_use', `${category.places} places use this category; retire it instead`, {
          places: category.places,
        });
      }
      if (category.active) await requireAnotherActive(id);
      await sql.begin(async (tx) => {
        await tx`update users set favorite_categories = array_remove(favorite_categories, ${id})`;
        await tx`delete from categories where id = ${id}`;
      });
      return reply.status(204).send();
    },
  );
}
