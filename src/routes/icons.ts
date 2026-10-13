import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import { HttpError, notFound } from '../errors.js';
import { checkIconPath, ICON_ID } from '../icons.js';
import { AdminIcon, AdminIconList } from '../schemas.js';

const label = z.string().trim().min(1).max(40);
const path = z.string().max(16000).meta({ description: 'SVG path data (`d`) on a 24×24 grid, filled even-odd' });
const idParams = z.object({ id: z.string().regex(ICON_ID) });

interface Row {
  id: string;
  label: string;
  path: string;
  updated_at: Date;
  user_id: string | null;
  user_name: string | null;
  categories: number;
}

/** The icon library for admins; categories point at an icon and the apps draw its path (GET /meta). */
export function iconRoutes(app: App, ctx: Ctx) {
  const { sql } = ctx;

  const select = (where = sql`true`) => sql<Row[]>`
    select i.id, i.label, i.path, i.updated_at, u.id as user_id, u.name as user_name,
           (select count(*)::int from categories c where c.icon = i.id) as categories
    from icons i left join users u on u.id = i.updated_by
    where ${where}
    order by lower(i.label), i.id
  `;

  const toIcon = (r: Row) => ({
    id: r.id,
    label: r.label,
    path: r.path,
    categories: r.categories,
    updated_at: r.updated_at.toISOString(),
    updated_by: r.user_id ? { id: r.user_id, display_name: r.user_name! } : null,
  });

  async function load(id: string) {
    const [row] = await select(sql`i.id = ${id}`);
    if (!row) throw notFound('Icon');
    return toIcon(row);
  }

  async function requireFreeLabel(text: string, except?: string) {
    const [taken] = await sql`
      select id from icons where lower(label) = lower(${text}) and id is distinct from ${except ?? null}
    `;
    if (taken) throw new HttpError(409, 'icon_exists', `An icon named ${text} already exists`);
  }

  app.get(
    '/admin/icons',
    {
      preHandler: ctx.admin,
      schema: {
        tags: ['Admin'],
        summary: 'Icons',
        description: 'The icon library, by name, with the number of categories using each icon.',
        response: { 200: AdminIconList },
      },
    },
    async () => ({ items: (await select()).map(toIcon) }),
  );

  app.post(
    '/admin/icons',
    {
      preHandler: ctx.admin,
      schema: {
        tags: ['Admin'],
        summary: 'Add an icon',
        description:
          'SVG path data on a 24×24 grid (the `d` attribute of a `<path>` in a `viewBox="0 0 24 24"` SVG), filled ' +
          'even-odd in the category colour — commands and numbers only. 422 `invalid_input` for anything else; ' +
          '409 `icon_exists` when the id or the name is taken.',
        body: z.object({ id: idParams.shape.id, label, path }),
        response: { 201: AdminIcon },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const d = checkIconPath(b.path);
      await requireFreeLabel(b.label);
      const [inserted] = await sql`
        insert into icons (id, label, path, updated_by) values (${b.id}, ${b.label}, ${d}, ${req.user.id})
        on conflict (id) do nothing
        returning id
      `;
      if (!inserted) throw new HttpError(409, 'icon_exists', `Icon ${b.id} already exists`);
      return reply.status(201).send(await load(b.id));
    },
  );

  app.patch(
    '/admin/icons/:id',
    {
      preHandler: ctx.admin,
      schema: {
        tags: ['Admin'],
        summary: 'Change an icon',
        description: 'Name or path; categories using the icon show the new path. 409 `icon_exists`.',
        params: idParams,
        body: z.object({ label: label.optional(), path: path.optional() }),
        response: { 200: AdminIcon },
      },
    },
    async (req) => {
      const { id } = req.params;
      const b = req.body;
      await load(id);
      const set: Record<string, unknown> = {};
      if (b.label !== undefined) {
        await requireFreeLabel(b.label, id);
        set.label = b.label;
      }
      if (b.path !== undefined) set.path = checkIconPath(b.path);
      if (Object.keys(set).length) {
        await sql`update icons set ${sql(set)}, updated_at = now(), updated_by = ${req.user.id} where id = ${id}`;
      }
      return load(id);
    },
  );

  app.delete(
    '/admin/icons/:id',
    {
      preHandler: ctx.admin,
      schema: {
        tags: ['Admin'],
        summary: 'Delete an icon',
        description: 'Only an icon no category uses (409 `icon_in_use` with `categories`).',
        params: idParams,
      },
    },
    async (req, reply) => {
      const icon = await load(req.params.id);
      if (icon.categories > 0) {
        throw new HttpError(409, 'icon_in_use', `${icon.categories} categories use this icon`, {
          categories: icon.categories,
        });
      }
      await sql`delete from icons where id = ${icon.id}`;
      return reply.status(204).send();
    },
  );
}
