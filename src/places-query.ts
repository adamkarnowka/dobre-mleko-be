import type { Sql } from './db.js';
import { isOpenAt, RANKING_PRIOR_WEIGHT, type Category, type OpeningPeriod } from './domain.js';

export type PlaceSort = 'best' | 'stars' | 'near' | 'newest';

export interface PlaceQuery {
  userId: string;
  month: string;
  ids?: string[];
  savedOnly?: boolean;
  ratedOnly?: boolean;
  q?: string;
  categories?: string[];
  near?: { lat: number; lng: number };
  maxDistanceKm?: number;
  sort?: PlaceSort;
  limit?: number;
  offset?: number;
}

export interface PlaceRow {
  id: string;
  name: string;
  category: Category;
  price_level: number | null;
  address: string | null;
  lat: number;
  lng: number;
  tags: string[];
  opening_hours: OpeningPeriod[] | null;
  created_at: Date;
  added_by_id: string;
  added_by_name: string;
  rating_avg: number | null;
  rating_count: number;
  stars_total: number;
  stars_month: number;
  score: number;
  cover_photo_hash: string | null;
  distance_km: number | null;
  saved: boolean;
  total: number;
}

/** Place cards with their aggregates: the shared query behind discover, saved places, top lists. */
export async function queryPlaces(sql: Sql, q: PlaceQuery): Promise<PlaceRow[]> {
  const near = q.near;
  const distance = near ? sql`distance_km(${near.lat}, ${near.lng}, p.lat, p.lng)` : sql`null::float8`;
  const search = q.q?.trim() ? `%${q.q.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%` : null;

  const order = {
    best: sql`score desc, rating_count desc, p.name`,
    stars: sql`stars_month desc, stars_total desc, score desc, p.name`,
    near: near ? sql`distance_km asc, p.name` : sql`score desc, p.name`,
    newest: sql`p.created_at desc`,
  }[q.sort ?? 'best'];

  return sql<PlaceRow[]>`
    with agg as (
      select place_id, avg(overall)::numeric(4, 2) as avg, count(*)::int as n from ratings group by place_id
    ), st as (
      select place_id, count(*)::int as total, (count(*) filter (where month = ${q.month}::date))::int as this_month
      from stars group by place_id
    ), prior as (
      select coalesce(avg(overall), 0)::float8 as m from ratings
    )
    select
      p.id, p.name, p.category, p.price_level, p.address, p.lat, p.lng, p.tags, p.opening_hours, p.created_at,
      u.id as added_by_id, u.name as added_by_name,
      agg.avg as rating_avg,
      coalesce(agg.n, 0) as rating_count,
      coalesce(st.total, 0) as stars_total,
      coalesce(st.this_month, 0) as stars_month,
      (prior.m * ${RANKING_PRIOR_WEIGHT} + coalesce(agg.avg, 0) * coalesce(agg.n, 0))
        / (${RANKING_PRIOR_WEIGHT} + coalesce(agg.n, 0))::float8 as score,
      (select ph.hash from place_photos ph where ph.place_id = p.id order by ph.created_at, ph.id limit 1) as cover_photo_hash,
      ${distance} as distance_km,
      exists (select 1 from saved_places sp where sp.user_id = ${q.userId} and sp.place_id = p.id) as saved,
      (count(*) over ())::int as total
    from places p
    join users u on u.id = p.added_by
    left join agg on agg.place_id = p.id
    left join st on st.place_id = p.id
    cross join prior
    where true
      ${q.ids ? sql`and p.id = any(${q.ids}::uuid[])` : sql``}
      ${q.savedOnly ? sql`and exists (select 1 from saved_places sp where sp.user_id = ${q.userId} and sp.place_id = p.id)` : sql``}
      ${q.ratedOnly ? sql`and agg.n > 0` : sql``}
      ${q.categories?.length ? sql`and p.category = any(${q.categories})` : sql``}
      ${
        search
          ? sql`and (p.name ilike ${search} or p.address ilike ${search}
                     or exists (select 1 from unnest(p.tags) t where t ilike ${search}))`
          : sql``
      }
      ${near && q.maxDistanceKm != null ? sql`and ${distance} <= ${q.maxDistanceKm}` : sql``}
    order by ${order}
    limit ${q.limit ?? 20} offset ${q.offset ?? 0}
  `;
}

export function toPlaceSummary(row: PlaceRow, timeZone: string, now: Date) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    priceLevel: row.price_level,
    address: row.address,
    location: { lat: row.lat, lng: row.lng },
    tags: row.tags,
    openNow: row.opening_hours ? isOpenAt(row.opening_hours, now, timeZone) : null,
    rating: { average: row.rating_avg, count: row.rating_count },
    stars: { total: row.stars_total, thisMonth: row.stars_month },
    coverPhotoUrl: row.cover_photo_hash ? `/photos/${row.cover_photo_hash}` : null,
    distanceKm: row.distance_km == null ? null : Math.round(row.distance_km * 10) / 10,
    addedBy: { id: row.added_by_id, name: row.added_by_name },
    saved: row.saved,
    createdAt: row.created_at.toISOString(),
  };
}
