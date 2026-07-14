# Prisma Migration — Plan B (Big-Bang Cutover) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **RED WINDOW (read first):** This is a big-bang cutover. From Task 1 (client swap) until the final integration task, `npm run typecheck` and the test suites are EXPECTED to be RED. Per-task reviews verify each rewrite's *correctness in isolation*; the whole-suite green gate is the final task. Do NOT treat mid-plan red as failure. (Accepted tradeoff — see spec.)

**Goal:** Cut finance-back over from Drizzle to Prisma and from bigint `id` to `uuid` PK, end-to-end: PrismaClient replaces the Drizzle client, every repository is rewritten, `HouseholdContext`/hook/types/subscription-layer drop numeric ids for uuid, e2e boots via `prisma db push`, all Drizzle is deleted, and the full suite goes green with an unchanged HTTP contract.

**Architecture:** Plan A already authored `prisma/schema.prisma` (uuidv7 PK) + generated `@prisma/client` and centralized enums in `src/domain/enums.ts`. Plan B swaps the runtime: `src/infra/db/client.ts` exports a `PrismaClient` as `db` (name preserved → `createXRepository(db)` call sites unchanged), repos are rewritten body-by-body, and the single-identifier (`uuid`) model removes all `id:number`↔`uuid` duality.

**Tech Stack:** Node 22, Fastify 5, TS strict ESM (`.js` specifiers), Prisma 6 (`@prisma/client`), Vitest + Testcontainers, pnpm.

## Global Constraints

- pnpm. ESM `.js` import specifiers. `zod/v4`.
- Enums/consts come from `src/domain/enums.ts` (Plan A) and `src/domain/subscription.ts`. Prisma model/enum types come from `@prisma/client` (`import { PrismaClient, type Membership } from "@prisma/client"` or `import type { Prisma } from "@prisma/client"`).
- **Identity is `uuid` only.** No `id:number` anywhere. FK columns are uuid strings. `HouseholdContext` = `{ uuid, type, role }` (no `id`).
- **Money `*_cents` fields are `BigInt` in Prisma** — convert to `number` at the repo mapping boundary (`Number(row.amountCents)`) since the domain/HTTP layer uses `number` (amounts fit JS safe-int). When writing, pass `BigInt(n)` or a number literal (Prisma accepts number for BigInt inputs).
- **Soft-delete** stays `deletedAt`: reads filter `where: { deletedAt: null }`; deletes set `deletedAt: new Date()`.
- Preserve each repo's existing **return-shape mapping** (the domain objects the tests assert) — only the query mechanism changes.
- HTTP contract must not change (API already exposes `uuid`, never `id`). Final task diffs the re-exported OpenAPI against the committed one.
- The DB is greenfield: tests/dev use `prisma db push` (no migration history needed for tests). A first real migration (`prisma migrate dev --name init`) is created in the scripts task for non-test envs.

## Drizzle → Prisma translation guide (apply in every repo task)

Reference — `createMembersRepository` before/after (real example):

Drizzle (before):
```ts
const rows = await db.select({ userId: user.uuid, name: user.name, role: membership.role })
  .from(membership).innerJoin(user, eq(user.id, membership.userId))
  .where(and(eq(membership.householdId, householdId), isNull(membership.deletedAt)));
```
Prisma (after — householdId is now a uuid string):
```ts
const rows = await db.membership.findMany({
  where: { householdId, deletedAt: null },
  select: { role: true, user: { select: { uuid: true, name: true } } },
});
return rows.map((r) => ({ userId: r.user.uuid, name: r.user.name, role: r.role, joinedAt: ... }));
```

Rules:
- `db.select().from(t).where(and(eq(t.a, x), isNull(t.deletedAt)))` → `db.t.findMany/findFirst({ where: { a: x, deletedAt: null } })`.
- joins → Prisma `select`/`include` on the relation (relations exist in schema).
- `.insert(t).values(v).returning()` → `db.t.create({ data: v })` (returns the row).
- bulk insert → `db.t.createMany({ data: [...] })` (no returning; if the ids are needed, create in a `$transaction` or use `createManyAndReturn`).
- `.update(t).set(v).where(...)` → `db.t.update({ where: { uuid }, data: v })` (single, by uuid) or `db.t.updateMany({ where, data: v })` (by non-unique filter).
- soft-delete → `update/updateMany({ ..., data: { deletedAt: new Date(), updatedBy, updatedAt: new Date() } })`.
- `sql\`count(*)::int\`` → `db.t.count({ where })`.
- `db.transaction(async (tx) => …)` → `db.$transaction(async (tx) => …)` (tx is a PrismaClient-like).
- entity writes must set `createdBy`/`updatedBy` (uuid strings) as today; `uuid` is auto (`@default(uuid(7))`) so omit it on create; `createdAt`/`updatedAt` are DB-managed (omit).
- Any `row.amountCents`/`*_cents` (BigInt) → `Number(...)` in the mapped result.
- Unique upserts (e.g. user by googleSub, refresh-token rotation) → `db.t.upsert({ where: { unique }, create, update })` where it maps cleanly; else find-then-create/update.

---

### Task 1: Swap the DB client to PrismaClient

**Files:** Modify `src/infra/db/client.ts`.

**Interfaces:** Produces `db: PrismaClient`, `type Db = PrismaClient`, `closeDb(): Promise<void>` (→ `db.$disconnect()`), `getPrisma()` if a getter is preferred. Export name `db` preserved so `createXRepository(db)` signatures are unchanged.

- [ ] **Step 1: Rewrite the client**

```ts
import { PrismaClient } from "@prisma/client";

export type Db = PrismaClient;

// Lazy singleton — no connection at import; first query connects.
let client: PrismaClient | undefined;
function getClient(): PrismaClient {
  if (!client) client = new PrismaClient();
  return client;
}
export const db: Db = getClient();

export async function closeDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
```

- [ ] **Step 2: Expectation** — `npm run typecheck` is now RED (every Drizzle repo body references `db.select`/table objects that no longer exist). This is expected; do not try to make the whole thing green. Commit the client swap so the red baseline is captured.

```bash
git add src/infra/db/client.ts
git commit -m "feat(prisma): swap DB client to PrismaClient (begins red window)"
```

> Reviewer note for Tasks 1–N: verify correctness of the changed file(s) in isolation (does the Prisma query express the same intent as the Drizzle one?), not whole-suite green.

---

### Task 2: uuid-only identity ripple — HouseholdContext, hook, shared types

**Files:** `src/types/household.ts`, `src/http/hooks/household/household.ts`, `src/http/api/households/households.types.ts`, `src/http/api/users/users.types.ts`.

**Interfaces:** `HouseholdContext = { uuid: string; type: HouseholdType; role: MembershipRole }` (drop `id: number`). `requireHousehold(req)` returns it; `requireHouseholdRole` resolves membership by the header uuid and attaches `{ uuid, type, role }`. Domain/DTO types drop numeric ids; the public id everywhere is `uuid`.

- [ ] **Step 1: Update `HouseholdContext`** — remove `id: number`; keep `uuid`, `type`, `role`. Update the doc comment.
- [ ] **Step 2: Update the household hook** — `findMembershipContext` (rewritten in the households repo task) returns `{ uuid, type, role }`; the hook attaches it. The header `x-household-id` is the household uuid (unchanged).
- [ ] **Step 3: Update `households.types.ts` / `users.types.ts`** — drop any numeric `id` fields; the domain objects carry `uuid` (they already expose uuid to the API; remove the internal numeric `id` if present).
- [ ] **Step 4: Commit** (still red overall):
```bash
git commit -am "feat(prisma): HouseholdContext + hook + types are uuid-only"
```

---

### Tasks 3–13: Rewrite each repository to Prisma + uuid (one per task)

For EACH repo below: read the current file + its route-handler consumers (the `index.ts`/`*.routes.ts` in the same folder), rewrite the repo body per the translation guide, and update its consumers to pass `hh.uuid` (not `hh.id`) and to treat returned ids as uuid strings. Keep the repo's public interface + return shapes identical (tests are the oracle). Where a consumer passed a numeric id, pass the uuid. Convert `*_cents` BigInt→Number in results.

Per-task verification (red window): `npx tsc --noEmit <just this area>` won't isolate cleanly, so instead **typecheck the whole repo and confirm the error count strictly DECREASES** vs before the task (this repo's errors resolved), and that no NEW error type appears outside the touched files. The reviewer checks query-intent equivalence against the old Drizzle code. Commit each.

- [ ] **Task 3 — `users.repository.ts`** (+ `users/index.ts`, `list-users` controller). Notes: user upsert by `googleSub`/`email` on login; `emailVerified`; exposes `uuid`. Google-login/dev-login create paths.
- [ ] **Task 4 — `auth.repository.ts` + `auth/tokens.ts`** (+ auth controllers). Notes: refresh-token insert (hashed), rotation (revoke old + insert new — use `$transaction`), lookup by `tokenHash`, `expiresAt`/`revokedAt` checks. FK `userId` is now the user uuid.
- [ ] **Task 5 — `households.repository.ts`** (+ `households/index.ts`). Notes: `create` (household + owner membership atomically → `$transaction`); `listForUser` (memberships→households with role); `findMembershipContext` → returns `{ uuid, type, role }`; `addMember` (ignore-if-exists → `upsert` on `@@unique([userId, householdId])`). All ids uuid.
- [ ] **Task 6 — `members.repository.ts`** (+ `members.routes.ts`). Notes: `listMembers` (join user), `countOwners`, `findMember` → returns `{ membershipUuid, userId(uuid), role }` (numeric membershipId/userId become uuid strings — update `members.routes.ts` + anything using them, incl. the subscription seat-sync which calls member counts), `updateRole`, `removeMember` (soft-delete). Also `countActiveMembers` semantics used by subscriptions.
- [ ] **Task 7 — `accounts.repository.ts`** (+ `accounts/index.ts`). Notes: list by household uuid, create, currency default.
- [ ] **Task 8 — `categories.repository.ts`** (+ `categories/index.ts`). Notes: system (householdId null) vs household categories; self-relation `parentId`; used by import categorization.
- [ ] **Task 9 — `transactions.repository.ts`** (+ `transactions/index.ts`). Notes: the heaviest — list with filters/paging (cursor over `occurredAt`+uuid now, not id), `amountCents` BigInt→Number, dedup by `rawRef`, joins to account/category, soft-delete. Preserve the cursor contract.
- [ ] **Task 10 — `imports.repository.ts`** (+ `imports/index.ts`). Notes: import-batch create/status update, transaction insert from parsed rows (preview/commit split from the import-wizard work), dedup on `rawRef` within payload + existing.
- [ ] **Task 11 — `insights.repository.ts`** (+ `insights/index.ts`). Notes: insight batch insert, "latest generation" read (max `generatedAt`), regeneration soft-deletes prior batch, 24h cache read.
- [ ] **Task 12 — `invitations.repository.ts`** (+ `invitations/index.ts`). Notes: create invite (code, role, expiresAt), `findActiveByCode` (join household → returns household uuid), revoke, list; redeem path calls `addMember` + seat-sync.
- [ ] **Task 13 — `subscriptions.data.ts`** (+ `subscriptions.service.ts`, `sync-seats.ts`, `subscriptions/index.ts`). Notes: `ownerEmail(householdUuid)` + `countActiveMembers(householdUuid)` now key on uuid; the service/`sync-seats` ctx becomes `{ uuid }` only (drop `id`); Stripe `metadata.householdId` already used the uuid — unchanged. Update the routes to pass `hh.uuid`.

Each: commit `feat(prisma): rewrite <area> repository to Prisma + uuid`.

---

### Task 14: e2e boot → `prisma db push`

**Files:** `test/e2e/helpers/app.ts` (+ `test/e2e/helpers/env.ts` if needed).

- [ ] **Step 1:** Replace the Drizzle `migrate()` block with applying the Prisma schema to the Testcontainer. After `setTestEnv({ DATABASE_URL: uri })`, run `prisma db push` against that URL before `buildApp`:
```ts
import { execFileSync } from "node:child_process";
// …after DATABASE_URL is set for the container:
execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
  env: { ...process.env, DATABASE_URL: uri },
  stdio: "inherit",
});
```
Ensure `@prisma/client` is generated before the suite (Task 15 adds `postinstall`; for local runs `prisma generate` must have run). Remove the Drizzle `migrate`/`drizzle` imports from the helper.
- [ ] **Step 2:** Commit `test(prisma): boot e2e via prisma db push`.

---

### Task 15: Scripts + seed + postinstall

**Files:** `scripts/migrate.ts`, `scripts/seed.ts`, `src/infra/db/seed/default-categories.ts`, `package.json`.

- [ ] **Step 1:** `scripts/migrate.ts` → run `prisma migrate deploy` (or delegate to the CLI). `db:migrate` script → `prisma migrate dev`, add `db:deploy` → `prisma migrate deploy`.
- [ ] **Step 2:** `src/infra/db/seed/default-categories.ts` → rewrite to Prisma (`db.category.createMany`/`create`). `scripts/seed.ts` keeps calling `seedDefaultCategories(db)` (db is now Prisma).
- [ ] **Step 3:** Add `"postinstall": "prisma generate"`. Wire `DATABASE_URL` for CLI runs (no root `.env` today — document that `db:migrate`/seed need `DATABASE_URL` exported, or add a `.env` that mirrors `.env.local`; do NOT commit secrets).
- [ ] **Step 4:** Create the initial migration for non-test envs: with a throwaway DB URL, `prisma migrate dev --name init` (generates `prisma/migrations/…_init`). Commit it. (Tests use `db push`; real envs use the migration.)
- [ ] **Step 5:** Commit `chore(prisma): prisma-based scripts, seed, postinstall, init migration`.

---

### Task 16: Teardown — delete all Drizzle

**Files:** delete `src/infra/db/tables/**/*.table.ts`, `src/infra/db/columns.ts`, `src/infra/db/schema.ts`, `src/infra/db/migrations/**` (drizzle SQL + meta), `drizzle.config.ts`; `package.json` remove `drizzle-orm`, `drizzle-kit`.

- [ ] **Step 1:** `grep -rn "drizzle" src scripts test` → must return ZERO hits (outside deleted files). Fix any straggler (should be none if Tasks 3–13 were complete).
- [ ] **Step 2:** `git rm` the files; `pnpm remove drizzle-orm drizzle-kit`.
- [ ] **Step 3:** Commit `chore(prisma): remove Drizzle (tables, config, migrations, deps)`.

---

### Task 17: Final integration — green gate + OpenAPI diff

- [ ] **Step 1:** `npx prisma generate` (fresh client).
- [ ] **Step 2:** `npm run typecheck` → **0 errors** (red window closes here). Fix whatever remains.
- [ ] **Step 3:** `npm run test:unit` → all pass.
- [ ] **Step 4:** `npm run test:e2e` → all pass (Docker up; boots via `prisma db push`).
- [ ] **Step 5:** OpenAPI contract unchanged: `npx tsx scripts/export-openapi.ts /tmp/api-after.json` and `git show HEAD:../finance-app/api.json`… — simpler: re-export to the app fixture path and `git -C ../finance-app diff --stat api.json`; expect **no diff** (API was already uuid-based). If anything shifted, investigate — the contract must not change.
- [ ] **Step 6:** Commit `feat(prisma): complete Drizzle→Prisma + uuid-PK cutover (suite green)`.

---

## Self-Review

**Spec coverage:** client swap (T1), uuid ripple hook/types/subscription (T2, T6, T13), all repos (T3–13), e2e boot (T14), scripts/seed/postinstall/init-migration (T15), teardown + deps (T16), final green + OpenAPI diff (T17). Big-bang red window explicitly framed. ✅

**Placeholder scan:** Per-repo tasks intentionally give file pointers + gotchas + the shared translation guide instead of full transcription (approved "pattern-guide" style; the existing tests are the parity oracle). Foundational tasks (client, HouseholdContext, e2e boot, scripts) carry full code. Not placeholders — deliberate, tests-gated.

**Type consistency:** `Db = PrismaClient` and `db` name preserved (T1) so `createXRepository(db)` signatures hold; `HouseholdContext { uuid, type, role }` consistent across T2/T6/T13; BigInt→Number rule stated once and applied in T9/T13. Enums sourced from `src/domain/enums.ts` (Plan A).

**Risk callouts:** red window (whole plan), transactions cursor contract (T9 — must preserve paging), refresh-token rotation atomicity (T4 — `$transaction`), members numeric→uuid ripple into subscription seat-sync (T6/T13), DATABASE_URL wiring for CLI/tests (T14/T15).

## Execution note
Because the suite is red T1→T17, this plan does NOT fit the per-task-green model cleanly. Recommended execution: implement T1–T16 with per-task correctness reviews (query-intent equivalence), then T17 is the single whole-suite green gate + a whole-branch review. Keep each repo task small so a reviewer can check its rewrite against the old Drizzle query.
