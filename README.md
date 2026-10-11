# dobre-mleko-be

Backend for **Dobre Mleko**: place ratings like Google Maps, but only from friends.
Only Google accounts on a whitelist can sign in.

Node 22 · TypeScript · Fastify · Postgres 16.

**API docs:** https://mwalczak.github.io/dobre-mleko-be/ (OpenAPI: [`openapi.json`](https://mwalczak.github.io/dobre-mleko-be/openapi.json)).

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
npm run openapi -- openapi.json   # the OpenAPI document, as published to the docs
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
| `PHOTO_DIR` | `./data/photos` | Where photo files are stored (a volume in production) |
| `CORS_ORIGINS` | none | Only needed for a browser client |
| `DEV_LOGIN` | `false` | Enables `POST /auth/dev` outside production |

## API

The full reference with request and response schemas is in the [API docs](https://mwalczak.github.io/dobre-mleko-be/),
generated from the route schemas in `src/` (responses are checked against the same schemas at runtime).

- **Sign-in:** the app signs in with Google and sends the Google ID token to `POST /auth/google`. The server
  checks the token, the whitelist, and returns a session token. Send it as `Authorization: Bearer <token>`.
- **Places:** `GET /places` (search, category and distance filters, sort by best / stars / near / newest),
  `POST`, `GET`, `PATCH`, `DELETE /places/:id`, `PUT|DELETE /places/:id/saved`.
- **Ratings:** `PUT|DELETE /places/:id/rating` with `vibe` and `offer` (required) and `service`, `value`
  (optional, "nie dotyczy"), each 1–5. Ranking uses a Bayesian average (prior weight of 3 ratings).
- **Golden stars:** `POST|DELETE /places/:id/star`, `STARS_PER_MONTH` per person, once per place per month,
  no effect on the rating.
- **Comments, photos, stats:** `/places/:id/comments`, `/places/:id/photos`, `/photos/:hash`, `/stats/network`,
  `/stats/me`, plus `/me`, `/me/saved`, `/me/ratings` and `/meta`.

Errors look like `{"error": {"code": "not_whitelisted", "message": "..."}}`.

### Photos

Photo files are stored in `PHOTO_DIR` under their SHA-256 (`<dir>/6b/6b7f…`); the database keeps only the hash,
type and size. The type is detected from the file (JPEG, PNG, WebP). Identical files share one copy, which is
deleted when the last photo using it goes. `GET /photos/:hash` is public and cached forever, so image
components need no headers; only hashes that belong to a photo are served.

## Deploy

CI (`ci.yml`) runs on every push and pull request. When it passes on `main`, `deploy.yml` builds the image,
pushes it to GHCR and applies `k8s.yaml` on the k3s server over SSH (same setup as `ip`). That creates the
`dobre-mleko` namespace with a Postgres StatefulSet (5 Gi volume), a 10 Gi volume for photos, the API and a
Traefik ingress with a cert-manager certificate. The API is deployed with the `Recreate` strategy because the
photo volume can be mounted by one pod at a time, so a deploy has a few seconds of downtime.

Repository secrets: `VPS_HOST`, `VPS_SSH_KEY`, `POSTGRES_PASSWORD` (letters and digits only, because it goes
into a URL: `openssl rand -hex 24`), `JWT_SECRET` (`openssl rand -base64 48`), `ALLOWED_EMAILS`.
Repository variables: `API_HOST` (the API's domain), `GOOGLE_CLIENT_IDS`.

To change the whitelist, edit the `ALLOWED_EMAILS` secret and re-run the "Build and deploy" workflow.
After the first run, make the GHCR package public or add an image pull secret.

Back up both the Postgres volume and the photos volume: the database refers to photo files by hash.

### API docs

`docs.yml` regenerates the docs on every push to `main` and publishes them to GitHub Pages. One-time setup:
Settings → Pages → Source: **GitHub Actions**.
