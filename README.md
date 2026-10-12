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
generated from the route schemas in `src/` (responses are checked against the same schemas at runtime).

- **Sign-in:** the app signs in with Google and sends the Google ID token to `POST /auth/google`. The server
  checks the token, the whitelist, and returns a session token. Send it as `Authorization: Bearer <token>`.
- **Places:** `GET /places` (search, category, distance and map-viewport (`bbox`) filters, sort by best / stars / near / newest),
  `POST`, `GET`, `PATCH`, `DELETE /places/:id`, `PUT|DELETE /places/:id/saved`.
- **Ratings:** `PUT|DELETE /places/:id/rating` with `vibe` and `offer` (required) and `service`, `value`
  (optional, "nie dotyczy"), each 1–5. Ranking uses a Bayesian average (prior weight of 3 ratings).
- **Golden stars:** `POST|DELETE /places/:id/star`, `starsPerMonth` per person, once per place per month,
  no effect on the rating.
- **Comments, photos, stats:** `/places/:id/comments`, `/places/:id/photos`, `/photos/:hash`, `/stats/network`,
  `/stats/me`, plus `/me`, `/me/saved`, `/me/ratings` and `/meta`.

Errors look like `{"error": {"code": "not_whitelisted", "message": "..."}}`.

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
| `maxPhotosPerPlace` | `12` | Photos per place |

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

Photo files are stored in `PHOTO_DIR` under their SHA-256 (`<dir>/6b/6b7f…`); the database keeps only the hash,
type and size. The type is detected from the file (JPEG, PNG, WebP). Identical files share one copy, which is
deleted when the last photo using it goes. `GET /photos/:hash` is public and cached forever, so image
components need no headers; only hashes that belong to a photo are served.

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
