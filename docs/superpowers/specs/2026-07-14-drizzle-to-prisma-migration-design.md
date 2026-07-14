# Drizzle → Prisma Migration (finance-back) — Design Spec

**Date:** 2026-07-14
**Project:** finance-back
**Status:** Approved for build (brainstorm 2026-07-14).

## Context

finance-back currently uses **Drizzle ORM** (+ drizzle-kit) over PostgreSQL: a shared `db` client (`src/infra/db/client.ts`), table definitions in `src/infra/db/tables/**/*.table.ts`, 5 SQL migrations, and ~25 non-test files that query via the Drizzle builder or import table-derived types/enums. e2e tests boot a real Postgres via Testcontainers and apply Drizzle migrations.

**Driver (elective, no Drizzle blocker):** Prisma's `schema.prisma` + `prisma migrate` workflow and DX, relation ergonomics (nested reads/writes vs hand-written joins), and team familiarity / standardization. This is a preference/standardization migration, not a fix for a Drizzle limitation.

## Goals

- Replace Drizzle with **Prisma** as the sole ORM. `schema.prisma` is the schema source of truth; `prisma migrate` owns migrations; `@prisma/client` is the query layer.
- Preserve all current **behavior**: the same 11 tables (columns, relations, unique/index constraints, enums, soft-delete), the same repository interfaces, the same HTTP contract. The existing repo unit tests + full e2e suite are the parity oracle and must stay green.
- Keep the codebase coherent — no Drizzle/Prisma coexistence.

## Decisions (from brainstorm)

- **Runtime:** plain Node host (`node dist/server.js`) → **standard Prisma Client** (default engine). No distroless/serverless engine gymnastics.
- **DB continuity:** **greenfield reset** — dev data is disposable. `schema.prisma` authored to model the current tables; DB dropped & recreated from a fresh initial Prisma migration. No introspect/baseline.
- **Migration style:** **big-bang**, single coordinated effort. No period where both ORMs are wired.
- **Audit columns:** `createdBy`/`updatedBy` (currently FK → `user.uuid`) modeled as **plain `String` (uuid), no Prisma relation/FK**. The app never traverses them as relations; this drops a fiddly FK-to-unique-column with no behavioral impact on a greenfield DB.
- **Column naming:** Prisma maps every field to the **current snake_case column name** via `@map` (`id`→`<table>_id`, `createdAt`→`created_at`, etc.) and each model to its current table name via `@@map`. Required for the incremental rewrite: during transition both ORMs query one physical schema, so Prisma's generated DDL must match the columns the still-Drizzle repos expect. (Once Drizzle is gone the `@map`s are harmless; leave them.)
- **Enums:** modeled as **Prisma enums** (roles, household type, insight kind/severity, import source, etc.).

## Architecture

### Prisma setup
- Deps: `prisma` (dev) + `@prisma/client`. `prisma/schema.prisma` (datasource `postgresql` from `env DATABASE_URL`; generator `prisma-client-js`).
- Scripts (package.json): `db:migrate` → `prisma migrate dev`, `db:deploy` → `prisma migrate deploy`, `db:seed` → prisma-based seed, `postinstall` → `prisma generate`.
- Remove: `drizzle-orm`, `drizzle-kit`, `drizzle.config.ts`, `src/infra/db/migrations/**` (drizzle SQL + meta), all `src/infra/db/tables/**/*.table.ts`, `src/infra/db/columns.ts`, `src/infra/db/schema.ts`.

### schema.prisma (11 models)
`account`, `refreshToken`, `category`, `goal`, `household`, `invitation`, `membership`, `importBatch`, `insight`, `transaction`, `user`.

Every model carries the entity block (faithful to `entityColumns`):
```
id        BigInt   @id @default(autoincrement())
uuid      String   @unique @default(uuid())
createdBy String
updatedBy String
createdAt DateTime @default(now())
updatedAt DateTime @updatedAt
deletedAt DateTime?
```
Real relations (e.g. `membership.userId → user`, `membership.householdId → household`, cascade on delete) modeled as Prisma relations to enable `include`/nested queries. All current unique indexes and secondary indexes preserved (e.g. `@@unique([userId, householdId])`, `@@index([householdId])`).

### Enum / type relocation (cross-cutting ripple)
The TS const arrays, union types, and rank maps that currently live inside `*.table.ts` (e.g. `MEMBERSHIP_ROLES` + `ROLE_RANK` + `MembershipRole`, household type, `INSIGHT_KINDS`/`INSIGHT_SEVERITIES`, import source) move into `src/domain/` modules (subscription enums already precedent-set there). Row/Insert types previously from Drizzle `$inferSelect`/`$inferInsert` are replaced by Prisma-generated model types (`Prisma.Membership`, etc.) or local input types. Every importer is repointed. Where a column is a Prisma enum, the domain TS const stays the source of truth for Zod validation (`z.enum(CONST)`), kept in sync with the Prisma enum (single list, referenced by both).

### Client (temporary dual-client during migration)
Incremental green requires both ORMs alive during the rewrite (swapping the shared `db` to `PrismaClient` in one shot would break every not-yet-migrated repo's typecheck simultaneously). So:
- **Plan A** adds a **new** Prisma client `prisma: PrismaClient` (lazy singleton; `prismaDisconnect()`), exported alongside the existing Drizzle `db`. Both point at the same physical DB (Prisma DDL matches via `@map`). Repos migrate to take `prisma` one at a time.
- Each repo factory keeps its signature style but is switched from `(db: Db)` to `(prisma: PrismaClient)` as it's rewritten; its call site passes `prisma`. A repo is never half-migrated.
- **Plan B teardown (final task):** once no repo uses Drizzle, delete the Drizzle `db`/`Db`/`getPool` exports and `closeDb`'s Drizzle path; the file exports only Prisma. Optionally rename `prisma`→`db` in a final mechanical pass, or keep `prisma` (decide in Plan B; keeping `prisma` avoids a needless churn commit).
- `closeDb()` during transition disconnects **both** clients so `app.close()` tears everything down.

### Repositories (~25 files — the bulk)
Mechanical-but-careful rewrite of each repository body from the Drizzle builder to the Prisma client:
- `db.select().from(t).where(and(eq...))` → `db.t.findMany/findFirst({ where })`
- inserts → `db.t.create({ data })` / `createMany`
- updates & soft-delete → `db.t.update/updateMany({ where, data: { deletedAt } })`
- `sql\`count(*)\`` → `db.t.count({ where })`
- `db.transaction(async (tx) => …)` → `db.$transaction(async (tx) => …)`
- hand-written joins → `include` / nested `where` where it reads cleaner
Return shapes must match today's mapped domain objects exactly (the repo tests assert them).

### e2e + scripts
- `test/e2e/helpers/app.ts`: replace the Drizzle `migrate()` against the Testcontainer with **`prisma db push`** (schemaless, fast, ideal for greenfield test DBs) executed against the container's connection URL before `buildApp`. `@prisma/client` must be generated before tests run.
- `scripts/migrate.ts` / `scripts/seed.ts` → Prisma equivalents (or thin wrappers over `prisma` CLI + a seed using the client).

## Testing / parity oracle

The migration is validated entirely by **existing behavior tests staying green**:
- All repository unit tests (per-repo).
- The full e2e suite (finance + multi-account + insights + import-wizard + subscription): real Postgres via Testcontainers, now provisioned via Prisma.
- `typecheck` (0 errors) after each task; `test:unit` + `test:e2e` green at the end.
No new feature tests are required — the point is behavior preservation.

## Decomposition → Two Plans

1. **Plan A — Foundation (adds Prisma alongside Drizzle; suite stays green throughout):** add Prisma deps; author `schema.prisma` (all 11 models with `@map`/`@@map` to current names, enums, relations, indexes); add the `prisma` client alongside Drizzle `db`; relocate all enums/const-arrays/rank-maps from `*.table.ts` into `src/domain/` modules (repoint importers — Drizzle table files still exist and still import the relocated consts); swap the e2e Testcontainer boot to `prisma db push` (Drizzle repos keep working against the Prisma-created, identically-named schema); Prisma-based seed/migrate scripts; migrate **one pilot repository** to `prisma` with its tests green. End state: `typecheck` + `test:unit` + `test:e2e` all green, both ORMs live, one repo on Prisma.
2. **Plan B — Bulk rewrite + teardown:** migrate the remaining ~24 repositories to `prisma`, **one repo per task**, each task ending with that repo's tests + the full suite green (so the tree is never red beyond one in-flight repo). Final teardown task: delete all `*.table.ts`, `columns.ts`, `schema.ts`, drizzle migrations, `drizzle.config.ts`; remove `drizzle-orm`/`drizzle-kit`; drop the Drizzle `db`/`Db` exports; full `typecheck` + `test:unit` + `test:e2e` green; re-export OpenAPI and diff it against the committed one to prove the HTTP contract did not shift.

> Plan B starts only once Plan A is green. The dual-client foundation is what makes one-repo-per-task safe: an unmigrated repo still uses Drizzle `db`, a migrated one uses `prisma`, and both hit the same physical schema.

## Non-Goals

- No schema/behavior changes, no new features, no perf tuning beyond what Prisma does by default.
- No data migration (greenfield reset).
- No deploy/infra changes beyond `prisma generate` in build (plain Node host).
- No switch to Prisma's engine-free/driver-adapter client (not needed for a plain host).

## Risks

- **Enum/type relocation ripple** — many files import consts from `*.table.ts`; missing one breaks the build. Mitigated by typecheck after each relocation + moving all consts in Plan A before repo rewrites.
- **Subtle return-shape drift** in a rewritten repo (e.g. Prisma returns `Date` vs a pre-mapped ISO string). Mitigated by the per-repo tests; rewrite keeps the existing mapping layer.
- **`prisma generate` ordering** in CI/tests — client must be generated before typecheck/tests. Mitigated by `postinstall` + an explicit generate step in the e2e boot task.
- **BigInt ids** — Prisma returns `BigInt` for `id`; today Drizzle `mode:"number"` returns `number`. Repos map `id`→number in places. Decide per-repo: use Prisma `@db` / keep BigInt internally and convert, OR model `id` as `Int`. The public API exposes `uuid`, not `id`, so internal `id` type is contained — but FK joins use it. Plan A pins the convention (recommend `BigInt` in schema, convert at the few numeric boundaries) and documents it for Plan B.
