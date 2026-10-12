-- Changes for the iOS API contract (docs/API_HANDOFF.md from the app repo), without invites.

create extension if not exists unaccent;
create extension if not exists pg_trgm;

-- unaccent() is only STABLE (it depends on the dictionary); pinning the dictionary makes it safe to index.
create function f_unaccent(text) returns text
  language sql immutable parallel safe strict
  as $$ select public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- Lower-cased, accent-free text that search matches against ("zolw" finds "Żółw").
create function place_search_text(name text, address text, description text, tags text[]) returns text
  language sql immutable parallel safe
  as $$
    select f_unaccent(lower(
      coalesce(name, '') || ' ' || coalesce(address, '') || ' ' || coalesce(description, '') || ' ' ||
      coalesce(array_to_string(tags, ' '), '')
    ))
  $$;

-- Places --------------------------------------------------------------------------------------------------
alter table places
  add column status text not null default 'active' check (status in ('active', 'temporarily_closed', 'closed')),
  add constraint places_description_length check (char_length(description) <= 500),
  add column search_text text generated always as (place_search_text(name, address, description, tags)) stored;
create index places_search_trgm_idx on places using gin (search_text gin_trgm_ops);
create index places_name_trgm_idx on places using gin (f_unaccent(lower(name)) gin_trgm_ops);
create index places_tags_idx on places using gin (tags);

-- Profiles ------------------------------------------------------------------------------------------------
alter table users
  add column badge text check (char_length(badge) between 1 and 16),
  add column favorite_categories text[] not null default '{}' check (cardinality(favorite_categories) <= 3),
  add column status text not null default 'active' check (status in ('active', 'suspended', 'deleted')),
  -- Set once the person has chosen their display name, badge and favourite categories in the app.
  add column profile_completed_at timestamptz,
  -- Own avatar on the photo volume; avatar_url (Google picture) is the fallback.
  add column avatar_hash char(64) check (avatar_hash ~ '^[0-9a-f]{64}$');

-- Photos belong to ratings ----------------------------------------------------------------------------------
-- A photo is uploaded first (place_id null), then attached when its uploader rates the place. Every rating has
-- at least one photo: (place_id, uploaded_by) of the photos = (place_id, user_id) of the rating.
alter table place_photos
  alter column place_id drop not null,
  drop constraint place_photos_place_id_hash_key,
  add column blurhash text check (char_length(blurhash) <= 100),
  add column width integer,
  add column height integer;
create index place_photos_rating_idx on place_photos (place_id, uploaded_by);
create index place_photos_unattached_idx on place_photos (created_at) where place_id is null;

-- Comments ------------------------------------------------------------------------------------------------
alter table comments
  drop constraint comments_body_check,
  add constraint comments_body_check check (char_length(body) between 1 and 1000),
  add column updated_at timestamptz;

-- The public profile of a member, embedded wherever a person is shown (authors, star givers, commenters).
-- The API turns avatar_hash into a signed URL; email is never part of it.
create function profile_json(u users) returns jsonb
  language sql stable
  as $$
    select jsonb_build_object(
      'id', u.id,
      'display_name', u.name,
      'badge', u.badge,
      'role', coalesce((select a.role from allowed_emails a where a.email = u.email), 'member'),
      'status', u.status,
      'favorite_categories', to_jsonb(u.favorite_categories),
      'avatar_hash', u.avatar_hash,
      'avatar_url', u.avatar_url,
      'created_at', u.created_at
    )
  $$;
