-- Categories become data, managed by admins (GET /meta category_details, /admin/categories).
-- Seeded with the categories the apps had built in; places refer to them by id.
create table categories (
  id         text primary key check (id ~ '^[a-z][a-z0-9_]{1,31}$'),
  label      text not null check (length(label) between 1 and 40),
  color      text not null check (color ~ '^#[0-9A-F]{6}$'),
  shape      text not null
               check (shape in ('circle', 'half', 'triangle', 'triangle_down', 'ring', 'square', 'quarter', 'house')),
  position   integer not null,
  -- Retired categories keep their places but are not offered for new ones.
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Who changed it last. No foreign key: wiping users (seed --reset, TRUNCATE ... CASCADE) must keep categories.
  updated_by uuid
);

create unique index categories_label_key on categories (lower(label));

insert into categories (id, label, color, shape, position) values
  ('food',     'Jedzenie', '#D7301F', 'circle',        1),
  ('coffee',   'Kawa',     '#141414', 'half',          2),
  ('bar',      'Bar',      '#1D4FA0', 'triangle',      3),
  ('club',     'Klub',     '#D7301F', 'triangle_down', 4),
  ('kids',     'Dzieci',   '#F2B900', 'ring',          5),
  ('culture',  'Kultura',  '#1D4FA0', 'square',        6),
  ('nature',   'Natura',   '#F2B900', 'triangle',      7),
  ('sport',    'Sport',    '#D7301F', 'quarter',       8),
  ('shopping', 'Zakupy',   '#1D4FA0', 'half',          9),
  ('hotel',    'Hotel',    '#141414', 'house',        10),
  ('other',    'Inne',     '#141414', 'square',       11);

alter table places drop constraint places_category_check;
alter table places add constraint places_category_fkey foreign key (category) references categories (id);
