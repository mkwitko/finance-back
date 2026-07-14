# Drizzle → Prisma Migration + uuid-PK (finance-back) — Design Spec

**Date:** 2026-07-14
**Project:** finance-back
**Status:** Approved for build (brainstorm 2026-07-14; revised after uuid-PK + big-bang decision).

## Context

finance-back uses **Drizzle ORM** (+ drizzle-kit) over PostgreSQL: a shared `db` client (`src/infra/db/client.ts`), table defs in `src/infra/db/tables/**/*.table.ts` (each also carrying TS enum/const arrays + `$infer` Row/Insert types + rank maps), `src/infra/db/columns.ts` (`entityColumns`), `src/infra/db/schema.ts` aggregator, 5 SQL migrations, and ~25 non-test files that query via the Drizzle builder. e2e tests boot real Postgres via Testcontainers and apply Drizzle migrations.

**Driver (elective, no Drizzle blocker):** Prisma DX (`schema.prisma` + `prisma migrate`), relation ergonomics (nested reads/writes vs hand-written joins), team familiarity / standardization. Combined with a data-model simplification requested during design: **collapse the dual `id`(bigint)/`uuid` identity down to a single `uuid` primary key.**

## Goals

- Replace Drizzle with **Prisma** as the sole ORM. `schema.prisma` is the schema source of truth; `prisma migrate` owns migrations; `@prisma/client` is the query layer.
- **Single identifier:** every model's primary key is `uuid` (`@default(uuid(7))`, time-ordered). The internal bigint `id` and all bigint FKs are **dropped**; every relation/FK references `uuid`.
- Preserve the **HTTP contract** and all business behavior. The API already exposes `uuid` (never the bigint `id`), so responses are unchanged; the existing repo unit tests + full e2e suite are the parity oracle.

## Decisions (from brainstorm)

- **Runtime:** plain Node host (`node dist/server.js`) → **standard Prisma Client** (default engine). No distroless/serverless engine work.
- **DB continuity:** **greenfield reset** — dev data disposable. `schema.prisma` authored fresh; DB dropped & recreated from the initial Prisma migration. No introspect/baseline, no data migration.
- **Identity:** **uuid is the PK** (`@id @default(uuid(7))`); bigint `id` removed everywhere. uuidv7 (time-ordered) preserves index/write locality otherwise lost by dropping the sequential bigint. (Requires a Prisma version supporting `uuid(7)` — Prisma 6; the plan pins the exact version.)
- **Migration style:** **big-bang, all-in-one** — Prisma + uuid-PK + every repo/hook/type rewritten together. `typecheck`/`test:unit`/`test:e2e` go **red during the effort and green only at the final integration**. The user explicitly accepted this over the safer incremental path (which uuid-PK made impossible: a uuid-PK physical schema can't coexist with still-on-Drizzle repos).
- **Column naming:** **Prisma default naming** (no `@map` to snake_case). Single ORM, greenfield, and no raw SQL depends on the old snake_case column names (the lone `sql\`count(*)\`` becomes `db.*.count()`), so the mapping burden is dropped.
- **Enums:** modeled as **Prisma enums** (membership role, household type, insight kind/severity, import source, etc.). The matching TS const arrays (for `z.enum(...)` HTTP validation + `ROLE_RANK`) live in `src/domain/` modules and stay the source of truth for app-side validation.
- **Audit columns:** `createdBy`/`updatedBy` modeled as plain `String` (uuid), **no relation/FK** (app never traverses them).

## Architecture

### Prisma setup
- Deps: `prisma` (dev) + `@prisma/client`. `prisma/schema.prisma` (datasource `postgresql` from `env DATABASE_URL`; generator `prisma-client-js`).
- Scripts: `db:migrate` → `prisma migrate dev`, `db:deploy` → `prisma migrate deploy`, `db:seed` → prisma seed, `postinstall` → `prisma generate`.

### schema.prisma (11 models)
`account`, `refreshToken`, `category`, `goal`, `household`, `invitation`, `membership`, `importBatch`, `insight`, `transaction`, `user`.

Shared entity block per model (replaces `entityColumns`):
```
uuid      String   @id @default(uuid(7))
createdBy String
updatedBy String
createdAt DateTime @default(now())
updatedAt DateTime @updatedAt
deletedAt DateTime?
```
- **No bigint `id`.** All FK columns are `String` uuids; relations reference the parent `uuid` (`@relation(fields: [householdId], references: [uuid], onDelete: Cascade)`).
- All current unique/secondary indexes preserved, now on uuid FK columns (e.g. `@@unique([userId, householdId])`, `@@index([householdId])`).
- Enums declared in-schema; the domain TS const arrays mirror them 1:1.

### Client
`src/infra/db/client.ts` exports a single Prisma client as `db: PrismaClient` (lazy singleton — no connection at import; instantiated on first use), `type Db = PrismaClient`, `closeDb()` → `db.$disconnect()`. Keeping the export name `db` and `Db` type means every `createXRepository(db)` call site + signature is unchanged; only repository bodies change.

### App-wide id → uuid ripple (beyond the 25 repos)
Dropping the bigint `id` changes identity handling across non-repo code, all landing in this big-bang:
- **`HouseholdContext`** (`src/types/household.ts`): drop `id: number`; becomes `{ uuid: string, type, role }`. `requireHousehold`/`requireHouseholdRole` (`src/http/hooks/household/household.ts`) resolve and pass `uuid` only.
- **Subscription layer** (built on the old `{ id:number, uuid }`): `subscriptions.data.ts`/`subscriptions.service.ts`/`sync-seats.ts` ctx becomes `{ uuid }` only; `ownerEmail`/`countActiveMembers` key on the household uuid; Stripe `metadata.householdId` already used the uuid — unchanged.
- **`members` repo**: `findMember` etc. return `userId`/`membershipId` as `string` (uuid), not `number`; `updateRole`/`removeMember` key on uuid.
- Every repository: numeric-id parameters/returns become uuid strings; no more id↔uuid duality or numeric conversions.

### Enum / type / const relocation
Const arrays, union types, rank maps currently inside `*.table.ts` (deleted) move to `src/domain/` modules (subscription enums already there). Drizzle `$inferSelect`/`$inferInsert` Row/Insert types → Prisma-generated model types (`Prisma.Membership`…) or local input types. Every importer repointed.

### e2e + scripts
- `test/e2e/helpers/app.ts`: replace Drizzle `migrate()` with **`prisma db push`** against the Testcontainer URL (fast, schemaless — ideal for greenfield test DBs), after ensuring `@prisma/client` is generated.
- `scripts/{migrate,seed}.ts` → Prisma equivalents.

### Teardown (same effort)
Delete `src/infra/db/tables/**/*.table.ts`, `columns.ts`, `schema.ts`, `src/infra/db/migrations/**` (drizzle), `drizzle.config.ts`; remove `drizzle-orm` + `drizzle-kit`.

## Testing / parity oracle

Validated by **existing behavior tests going green at the end**: all repo unit tests + the full e2e suite (finance, multi-account, insights, import-wizard, subscription), now on Prisma. Plus: re-export OpenAPI and **diff against the committed `api.json`** to prove the HTTP contract did not shift (must be identical). No new feature tests.

## Decomposition → Plans

Because it's big-bang, the tree is **red until the final integration task**; per-task reviews check the correctness of each rewrite in isolation, and the final task brings the whole suite green. Two plans:

1. **Plan A — Schema + infra + shared ripple:** Prisma deps + `schema.prisma` (11 models, uuid(7) PK, enums, relations, indexes); Prisma `db` client; relocate all enums/consts/types into `src/domain/`; update `HouseholdContext` + household hook + auth/types to uuid-only; e2e boot → `prisma db push`; seed/migrate scripts. (Repos not yet rewritten → typecheck red at end of Plan A; that is expected and called out.)
2. **Plan B — Repos + teardown + green:** rewrite all ~25 repositories to Prisma + uuid (grouped into tasks by domain area); update the subscription data/service/members ripple; delete all Drizzle files + deps; then the **final integration task**: `prisma generate`, `typecheck` 0, `test:unit` green, `test:e2e` green, OpenAPI re-export diff clean.

## Non-Goals

- No HTTP contract change (API already uuid-based), no new features, no perf tuning beyond uuidv7 locality.
- No data migration (greenfield).
- No deploy/infra change beyond `prisma generate` in build.
- No engine-free/driver-adapter Prisma client (plain host).

## Risks

- **Big-bang red window** — the suite is broken mid-migration; a mistake is only caught at final integration, and debugging spans many files at once. Accepted by the user. Mitigation: land Plan A cleanly (schema/client/relocation) before touching repos; rewrite repos in small per-domain tasks reviewed individually; keep each repo's existing return-mapping so the parity tests pin behavior.
- **uuid-PK app-wide ripple** — identity type changes leak into hooks, types, and the freshly-built subscription layer, not just repos. Mitigation: the relocation/hook/type changes are a dedicated Plan A step; a repo-wide grep for numeric-id usage seeds the task list.
- **Enum/const relocation** — a missed importer breaks the build. Mitigation: relocate all consts in Plan A, typecheck-driven.
- **uuidv7 support** — requires the Prisma version that ships `uuid(7)`; plan pins it and falls back to `uuid(4)` only if unavailable (noting the locality tradeoff).
- **Return-shape drift** (Prisma `Date`/`BigInt`-free now, but nested vs flat) — mitigated by per-repo tests and preserving each repo's mapping layer.
