# finance-back

Finance backend API. Node.js 22 + Fastify 5 + TypeScript (strict), Zod 4 +
`fastify-type-provider-zod`, Drizzle + `pg` on PostgreSQL 16, vertical-slice
architecture, Pino logs, typed error catalog, Vitest tests. Follows the
`b2b-reservas-backend` company standard (see `skills/`).

> **Auth deviation from the standard.** The company standard uses AWS Cognito JWT
> verify. This service instead uses **custom app JWT + Google Sign-In** — no
> Cognito/Amplify. Google ID tokens are verified with `google-auth-library`; the app
> issues/verifies its own JWTs with `@fastify/jwt`.

## Requirements

- Node.js 22+, pnpm 10, Docker (for local Postgres and Testcontainers).

## Run it

```bash
cp .env.example .env            # fill JWT_SECRET + GOOGLE_CLIENT_IDS
pnpm install
pnpm dev:db                     # start Postgres (docker compose)
pnpm db:migrate                 # apply migrations
pnpm dev:native                 # start API with hot reload (tsx watch)
# or: pnpm dev                  # docker compose up postgres + API
```

- Health: `GET http://localhost:3000/health`
- OpenAPI: `GET http://localhost:3000/openapi.json` (and Swagger UI at `/docs`).
  The mobile app generates its typed client from this document via **Kubb**.

### Scripts

| Script | What |
|---|---|
| `pnpm dev:native` | API with hot reload |
| `pnpm build` / `pnpm start` | tsup build → run `dist/server.js` |
| `pnpm typecheck` | `tsc --noEmit` (strict) |
| `pnpm check` / `pnpm check:fix` | Biome lint + format |
| `pnpm test:unit` / `pnpm test:e2e` / `pnpm test` | Vitest |
| `pnpm db:generate` / `pnpm db:migrate` | Drizzle migrations |

## Auth contract (shared with the Expo mobile app)

All routes are authenticated by default (the app JWT is verified by a global
preHandler). Opt out with `config: { public: true }`. Persona authorization per route
via `config: { permissions: { any: [...] } }`, sourced from the access token's
`authorities` claim.

| Route | Auth | Body | Returns |
|---|---|---|---|
| `POST /auth/google` | public | `{ idToken }` | `{ accessToken, refreshToken, expiresIn }` |
| `POST /auth/refresh` | public | `{ refreshToken }` | `{ accessToken, refreshToken, expiresIn }` (rotated) |
| `POST /auth/logout` | any persona | `{ refreshToken }` | `204` (revokes the refresh token) |
| `GET /me` | any persona | — | current user + personas |
| `GET /users` | `HOTEL_ADMIN` \| `AGENCY_ADMIN` | — | user list (sample persona-gated slice) |
| `GET /health` | public | — | `{ status: "ok" }` |

**`POST /auth/google`** — the mobile app obtains a Google ID token via Google
Sign-In and posts it here. The backend verifies it with
`OAuth2Client.verifyIdToken` (audience = `GOOGLE_CLIENT_IDS`), upserts the user by
Google `sub`/email, loads personas, and returns the token pair.

**Access token** — short-lived app JWT (`ACCESS_TOKEN_TTL_SECONDS`, default 15 min),
HS256 signed with `JWT_SECRET` (RS256 with a key pair is the documented future
option). Payload: `sub` (internal user uuid), `email`, `name`, and `authorities`
(nested-by-system persona claim, e.g. `{ "FINANCE_API": ["HOTEL_ADMIN"] }` — the same
claim/shape the frontend reads).

**Refresh token** — opaque random value, stored **hashed** (sha256) in the
`refresh_token` table so it can be revoked. `POST /auth/refresh` rotates it (revokes
the old, issues a new one); `POST /auth/logout` revokes it.

**Personas** — catalog in `src/shared/permissions/catalog.ts`
(`HOTEL_ADMIN`, `HOTEL_STAFF`, `AGENCY_ADMIN`, `AGENCY_STAFF`), namespaced under the
`FINANCE_API` system. No action-fine permissions (no `X:CREATE`).

## Database tables

Every table carries the standard columns (`entityColumns`): bigint identity PK
(`<table>_id`, internal — never exposed), public `uuid`, `created_by`/`updated_by`
(→ `user.uuid`), `created_at`/`updated_at` (`timestamptz`, UTC), `deleted_at`.

- **`user`** — identity owner. `google_sub` (unique), `email`, `name`, `picture`,
  `email_verified`. No password ever stored.
- **`user_persona`** — user ↔ persona link (`persona` role string, unique per user).
- **`refresh_token`** — `token_hash` (unique), `expires_at`, `revoked_at`, FK → `user`.

The baseline migration seeds the SYSTEM actor (`user.uuid =
00000000-0000-0000-0000-000000000001`) used to stamp `created_by`/`updated_by` on
rows written outside a user request (including first-access Google upsert). The
`user.created_by`/`updated_by` FKs are `DEFERRABLE INITIALLY DEFERRED` so the SYSTEM
row can self-reference.

## Architecture

Vertical slice: `src/http/api/<resource>/<operation>/` = `*.controller.ts`
(route + schema + handler) + `*.service.ts` (factory → pure function) +
`*.schema.ts` (Zod) + `*.test.ts`. Repositories are factories
(`createXRepository(db)`) shared per resource. External calls go through
`app.gateways` (here: `google`) so they can be faked in tests. Typed errors via the
`ERRORS.<SIGLA>.<NAME>()` catalog (`SIGLA-TNNNN`), i18n in pt-BR/en-US/es-ES.
