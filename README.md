# dobre-mleko-be

Backend for **Dobre Mleko**: place ratings like Google Maps, but only from friends.
Only Google accounts on a whitelist can sign in.

Node 22 · TypeScript · Fastify · Postgres 16.

## Run locally

```sh
cp .env.example .env     # set DATABASE_URL, ALLOWED_EMAILS, ...
createdb mleko
npm install
npm run dev
```

Migrations in `migrations/` run on startup (`npm run migrate` runs them on their own).
With `DEV_LOGIN=true` (ignored in production) `POST /auth/dev {"email": "..."}` signs you in
as a whitelisted email without Google, which is handy while building the mobile app.

### Tests

Tests use a real Postgres; each test file recreates the schema in the test database:

```sh
createdb mleko_test
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/mleko_test npm test
npm run typecheck
```

## Configuration

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | – | Postgres connection string |
| `ALLOWED_EMAILS` | – | Comma-separated Google emails that may sign in. Removing an email cuts that person off on their next request. |
| `GOOGLE_CLIENT_IDS` | – | Comma-separated OAuth client IDs (iOS, Android, web) whose ID tokens are accepted |
| `JWT_SECRET` | – | At least 32 characters, signs session tokens |
| `SESSION_TTL_DAYS` | `30` | |
| `STARS_PER_MONTH` | `3` | Golden stars per person per month |
| `TIME_ZONE` | `Europe/Warsaw` | Month boundaries for stars, "open now" |
| `MAX_PHOTO_BYTES` | `8388608` | |
| `CORS_ORIGINS` | none | Only needed for a browser client |
| `DEV_LOGIN` | `false` | Enables `POST /auth/dev` outside production |

## API

Everything except `/healthz`, `/meta`, `/auth/*` and `GET /photos/:id` needs `Authorization: Bearer <token>`.
Errors look like `{"error": {"code": "not_whitelisted", "message": "..."}}`.

### Auth and profile

| | |
|---|---|
| `POST /auth/google` `{idToken}` | Exchanges a Google ID token (from Google Sign-In on the phone) for `{token, expiresAt, user}`. 403 `not_whitelisted` if the email isn't on the list. |
| `GET /me` · `PATCH /me {name}` | Profile, including `stars: {perMonth, left, month}` |
| `GET /me/saved` | Saved places ("Zapisz") |
| `GET /me/ratings` | My ratings |

### Places

| | |
|---|---|
| `GET /meta` | Categories, rating criteria, stars per month |
| `GET /places` | Discover. Query: `q` (name, address, tags), `category=bar,club`, `lat`+`lng`, `maxDistanceKm`, `sort=best\|stars\|near\|newest`, `limit`, `offset`. Returns `{total, items}`. |
| `POST /places` | `{name, category, location: {lat, lng}, priceLevel?, address?, description?, tags?, openingHours?, googlePlaceId?}`. 409 `place_exists` (with `placeId`) for a duplicate `googlePlaceId`. |
| `GET /places/:id[?lat&lng]` | Details: aggregates, per-criterion averages, strongest criterion, photos, my rating, my star |
| `PATCH /places/:id` · `DELETE /places/:id` | Only by the person who added it |
| `PUT /places/:id/saved` · `DELETE /places/:id/saved` | Save / unsave |

Categories: `food coffee bar club kids culture nature sport shopping other`.
`openingHours`: `[{day: 0–6 (0 = Sunday), open: "18:00", close: "02:00"}]`; a closing time earlier than the opening time means after midnight.

### Ratings and golden stars

| | |
|---|---|
| `PUT /places/:id/rating` | `{vibe, offer, service?, value?}`, each 1–5. `vibe` (klimat) and `offer` (oferta) are required; `service` (obsługa) and `value` (wartość) may be `null` ("nie dotyczy"). Overall = average of the given criteria. One rating per person; PUT again to change it. |
| `DELETE /places/:id/rating` | |
| `POST /places/:id/star` | Golden star ("musisz tam iść"): doesn't affect the rating, at most `STARS_PER_MONTH` a month, once per place per month. 409 `no_stars_left`. |
| `DELETE /places/:id/star` | Takes back this month's star and returns it to the quota |

Ranking (`sort=best`, top 10) uses a Bayesian average: each place's mean is pulled towards the network mean
with the weight of 3 ratings, so a single 5★ doesn't beat a place with many high ratings.

### Comments and photos

| | |
|---|---|
| `GET /places/:id/comments` · `POST /places/:id/comments {body}` | Each comment carries the author's current overall rating of the place |
| `DELETE /comments/:id` | Own comments only |
| `POST /places/:id/photos` | `multipart/form-data`, one JPEG/PNG/WebP file. Max 12 per place; the first is the cover. Resize on the phone before uploading. |
| `GET /photos/:id` | Public (random UUID URLs) and cached forever, so image components need no headers |
| `DELETE /photos/:id` | Uploader or place author |

### Stats

| | |
|---|---|
| `GET /stats/network` | Places, people, ratings, average, stars this month, star of the month, top 10, category split |
| `GET /stats/me` | Places added, ratings, average given, comments, saved, stars |

## Deploy

Same setup as `ip`. CI runs on every push and pull request; when it passes on `main`, `deploy.yml` builds the
image, pushes it to GHCR and applies `k8s.yaml` on the k3s server over SSH. That creates the `dobre-mleko`
namespace with a Postgres StatefulSet (5 Gi volume), the API, and a Traefik ingress with a cert-manager certificate.

Repository secrets: `VPS_HOST`, `VPS_SSH_KEY`, `POSTGRES_PASSWORD` (letters and digits only, because it goes
into a URL: `openssl rand -hex 24`), `JWT_SECRET` (`openssl rand -base64 48`), `ALLOWED_EMAILS`.
Repository variables: `API_HOST` (the API's domain), `GOOGLE_CLIENT_IDS`.

To change the whitelist, edit the `ALLOWED_EMAILS` secret and re-run the "Build and deploy" workflow.
After the first run, make the GHCR package public or add an image pull secret.
