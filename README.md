# dobre-mleko-be

Backend for **Dobre Mleko**: place ratings like Google Maps, but only from friends.
Only Google accounts on a whitelist can sign in; admins manage the whitelist and settings in a dashboard at `/admin/`.

Node 22 · TypeScript · Fastify · Postgres 16 with PostGIS.

**API docs:** https://mwalczak.github.io/dobre-mleko-be/ (OpenAPI: [`openapi.json`](https://mwalczak.github.io/dobre-mleko-be/openapi.json)).

## Run locally

```sh
cp .env.example .env     # set DATABASE_URL, ADMIN_EMAILS, ...
# Postgres 16 with PostGIS, e.g.:
#   docker run -d -p 5432:5432 -e POSTGRES_USER=mleko -e POSTGRES_PASSWORD=mleko postgis/postgis:16-3.5-alpine
# or on Debian/Ubuntu: apt install postgresql-16-postgis-3
createdb mleko
npm install
npm run dev
```

Migrations in `migrations/` run on startup (`npm run migrate` runs them on their own).
With `DEV_LOGIN=true` (ignored in production) `POST /auth/dev {"email": "..."}` signs you in
as a whitelisted email without Google, which is handy while building the mobile app. The dashboard at
http://localhost:8080/admin/ then shows an e-mail sign-in form too.

### Tests

Tests use a real Postgres; each test file recreates the schema in the test database:

```sh
createdb mleko_test
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/mleko_test npm test
npm run typecheck
npm run openapi -- openapi.json   # the OpenAPI document, as published to the docs
```

## Configuration

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | – | Postgres connection string |
| `ADMIN_EMAILS` | – | Comma-separated admins. Always whitelisted with the admin role (re-applied at every start) and cannot be removed or demoted in the dashboard, so nobody can lock everyone out. |
| `GOOGLE_CLIENT_IDS` | – | Comma-separated OAuth client IDs of the mobile apps whose ID tokens are accepted |
| `GOOGLE_WEB_CLIENT_ID` | – | OAuth client ID of type "Web application" for the dashboard's sign-in button (authorised JavaScript origin: `https://<API_HOST>`) |
| `JWT_SECRET` | – | At least 32 characters, signs session tokens |
| `TIME_ZONE` | `Europe/Warsaw` | Month boundaries for stars, "open now" |
| `PHOTO_DIR` | `./data/photos` | Where photo files are stored (a volume in production) |
| `CORS_ORIGINS` | none | Only needed for a browser client |
| `DEV_LOGIN` | `false` | Enables `POST /auth/dev` outside production |

## API

The full reference with request and response schemas is in the [API docs](https://mwalczak.github.io/dobre-mleko-be/),
generated from the route schemas in `src/` (responses are checked against the same schemas at runtime). It follows
the iOS app's API contract (`docs/API_HANDOFF.md` in the app repo) except invites and the invite tree.

**Conventions:** JSON in `snake_case`, dates in ISO 8601 (UTC), ids are UUID strings. Lists take `limit` (default 30)
and `cursor`, and return `{ items, next_cursor, total }`. Errors are `{"error": "<code>", "message": "..."}`:

| Code | HTTP | When |
|---|---|---|
| `not_authenticated` | 401 | No or expired session: sign in again |
| `not_authorized` | 403 | Not on the whitelist, suspended, or not allowed to do this |
| `not_found` | 404 | No such resource |
| `invalid_input` | 422 | Validation (scores, lengths, missing photo, …) |
| `no_gold_stars_left`, `gold_star_already_awarded`, `gold_star_revoke_window_passed` | 409 | Gold star rules |
| `rating_needs_photo`, `too_many_photos`, `place_exists` | 409 | Other conflicts |
| `unsupported_type` / `file_too_large` | 415 / 413 | Uploads |

- **Sign-in:** the app signs in with Google and sends the ID token to `POST /auth/google`, which checks the token
  and the whitelist and returns a session token (`Authorization: Bearer <token>`). While `has_profile` is false the
  app shows onboarding and finishes it with `POST /me/profile` (display name, badge up to 16 characters, up to 3
  favourite categories).
- **Places:** `GET /places` searches name, description, address and tags ignoring case and Polish accents, and
  filters by categories, minimum rating, gold stars, tags, prices, radius, map viewport (`bbox`), author, unrated by
  me, saved, closed; sorts by `best` (rank_score), `gold_stars`, `nearest`, `newest`, `most_commented`.
  `POST /places` adds a place **together with the author's rating and photos** (and optionally a gold star).
  Places have a `status` (`active`, `temporarily_closed`, `closed`); the author or an admin edits them.
- **Ratings:** `PUT|DELETE /places/:id/rating`: `vibe` and `offer` required, `service` and `value` optional
  ("nie dotyczy"), each 1–5. **Every rating has at least one photo** (up to `maxPhotosPerRating`).
- **Gold stars:** `POST|DELETE /places/:id/gold-star`: `starsPerMonth` per person per month, once per place per
  month, revocable during that month. They don't change the average; each adds `starRankBonus` to rank_score:
  `rank_score = v/(v+3)·R + 3/(v+3)·C + bonus·gold_star_count`.
- **Comments:** 1–1000 characters, oldest first; the author edits, the author or an admin deletes.
- **Stats:** `/stats/network` (incl. star of the month, top 10, categories, weekly activity) and `/stats/me`
  (incl. rating distribution and taste matches: Pearson correlation on places both rated, at least 3).

### Whitelist, admins and settings

Who may sign in lives in the database (`allowed_emails`): each entry is an e-mail with the role `member` or
`admin` and an optional note, and can exist before the person first signs in. Every request re-checks the
whitelist and role, so removing someone or changing their role applies immediately to their existing session;
their places, ratings and comments stay. Admins cannot demote or remove themselves or anyone in `ADMIN_EMAILS`.

Runtime settings (`settings` table, defaults in `src/settings.ts`), editable in the dashboard:

| Setting | Default | |
|---|---|---|
| `starsPerMonth` | `3` | Golden stars per person per month |
| `sessionTtlDays` | `30` | Sign-in length, for new sign-ins |
| `maxPhotoBytes` | 8 MB | Largest photo upload (100 KB – 25 MB) |
| `maxPhotosPerRating` | `6` | Photos per rating (at least 1) |
| `starRankBonus` | `0.15` | rank_score added per gold star |

Secrets and infrastructure (database, JWT secret, Google client IDs, time zone, photo directory) stay in
environment variables. Admin endpoints are under `/admin/*` in the API docs.

### Admin dashboard

`/admin/` is a static page (plain HTML, CSS and JS in `admin/`, no build step) served by the API, with a strict
Content-Security-Policy. It signs in with Google (needs `GOOGLE_WEB_CLIENT_ID`) and offers:

- **Ludzie:** add people (e-mail, role, note), change roles and notes, remove people; shows who has signed in,
  when they were last active and how many places and ratings they have.
- **Ustawienia:** the settings above with their defaults and ranges, who changed them and when, and a reset.

### Location queries

Places keep `lat`/`lng`; a generated PostGIS column `geom` (`geometry(Point, 4326)`) follows them, with two
GiST indexes: on `geom` for map viewports (`bbox`, `geom && ST_MakeEnvelope(...)`) and on `geom::geography`
for distances in metres (`maxDistanceKm` via `ST_DWithin`, `sort=near` via the `<->` nearest-neighbour operator,
`distanceKm` via `ST_Distance`).

### Photos

Photos belong to ratings. The app uploads a photo first (`POST /photos`, multipart, with an optional `blurhash`
field), then passes its id in `photo_ids` when adding a place or rating one; uploads never attached are removed
after 24 hours. Avatars are uploaded with `PUT /me/avatar`.

Files are stored in `PHOTO_DIR` under their SHA-256 (`<dir>/6b/6b7f…`, plus a 400 px JPEG thumbnail `….thumb`); the
database keeps only the hash, type, size, dimensions and blurhash. The type is detected from the file. Identical
files share one copy, deleted when nothing uses it any more.

Photos are private: responses carry signed URLs (`/files/<hash>?exp=…&sig=…`, thumbnails at `/files/<hash>/thumb`)
that expire after 12–24 hours and stay the same within a 12-hour window, so clients can cache them.

### Database extensions

PostGIS (locations), `pg_trgm` (indexed substring search) and `unaccent` (accent-insensitive search), plus
`pgcrypto`. All are created by the migrations; the `postgis/postgis` image ships them.

## Deploy

CI (`ci.yml`) runs on every push and pull request. When it passes on `main`, `deploy.yml` builds the image,
pushes it to GHCR and applies `k8s.yaml` on the k3s server over SSH (same setup as `ip`). That creates the
`dobre-mleko` namespace with a Postgres + PostGIS StatefulSet (5 Gi volume), a 10 Gi volume for photos, the API and a
Traefik ingress with a cert-manager certificate. The API is deployed with the `Recreate` strategy because the
photo volume can be mounted by one pod at a time, so a deploy has a few seconds of downtime.

Repository secrets: `VPS_HOST`, `VPS_SSH_KEY`, `POSTGRES_PASSWORD` (letters and digits only, because it goes
into a URL: `openssl rand -hex 24`), `JWT_SECRET` (`openssl rand -base64 48`), `ADMIN_EMAILS`.
Repository variables: `API_HOST` (the API's domain), `GOOGLE_CLIENT_IDS`, `GOOGLE_WEB_CLIENT_ID`.

The whitelist and settings are managed in the dashboard at `https://<API_HOST>/admin/`. Changing `ADMIN_EMAILS`
needs the secret edited and the "Build and deploy" workflow re-run.
After the first run, make the GHCR package public or add an image pull secret.

Back up both the Postgres volume and the photos volume: the database refers to photo files by hash.

### API docs

`docs.yml` regenerates the docs on every push to `main` and publishes them to GitHub Pages. One-time setup:
Settings → Pages → Source: **GitHub Actions**.
