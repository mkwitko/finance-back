# Statement Import Wizard — Backend (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split statement import into a `preview` (parse + AI-categorize, no persist, flag duplicates) and a `commit` (persist the user's reviewed rows) endpoint, so the frontend wizard can show a review step — without breaking the existing all-in-one `POST /imports`.

**Architecture:** Extract two shared helpers (`parseRows`, `categorizeRows`) from today's `import.service.ts`; refactor the existing service to use them (behavior unchanged, guarded by the existing import e2e); add `previewImport` + `commitImport` services and their routes/schemas. No new tables.

**Tech Stack:** Node 22, Fastify 5, fastify-type-provider-zod, Zod 4 (`zod/v4`), Drizzle, Vitest (unit + e2e Testcontainers), Deepseek gateway.

## Global Constraints

- Zod from `"zod/v4"`; routes use `withTypeProvider<ZodTypeProvider>()` + `operationId` (camelCase, unique) + `tags` + `summary` + `response`. Presenters expose `uuid` as `id`; the account is addressed by public `uuid` in bodies and resolved to the internal id via `accountsRepo.findByUuid(householdId, uuid)` (as the existing `/imports` route does).
- Reuse existing repo methods verbatim: `importsRepo.existingRawRefs(accountId, refs)`, `importsRepo.createBatch(...)`, `importsRepo.markCompleted/markFailed`, `transactionsRepo.createMany(inputs)`, `categoriesRepo.listVisible(householdId)`. Do NOT change their signatures.
- `NormalizedRow` (from `parsers.ts`) = `{ amountCents, direction, occurredAt: Date, description, rawRef: string | null }`. `parseOfx`/`parseCsv` are pure; receipt uses `gateway.extractReceipt(text)`.
- Household-scoped routes: `preHandler: requireHouseholdRole("adult")`, `requireHousehold(req)`, `requireUser(req).sub` = actor uuid.
- Keep `POST /imports` working unchanged (existing e2e `finance.e2e.test.ts` imports through it).
- Gateway never throws (categorize returns `[]` on failure → rows just come back uncategorized). Preview/commit must not fail when categorization is empty.
- Tests: `pnpm test:unit` (no Docker) + `pnpm test:e2e` (Testcontainers, Docker available). Unit tests get dummy env via `test/unit-setup.ts` (already wired).
- Commit on `master`; stage only the files each task names (never `git add -A`).

---

### Task 1: Refactor import.service — shared helpers + preview/commit services

**Files:**
- Modify: `src/http/api/imports/import.service.ts`
- Test: `src/http/api/imports/import-preview.test.ts` (unit, with fakes — asserts preview does not persist and flags duplicates using injected fake repos)

**Interfaces:**
- Consumes: `parseOfx`/`parseCsv`/`NormalizedRow`, `DeepseekGateway`, the repos.
- Produces:
  - types `PreviewRow = { amountCents: number; direction: "in"|"out"; occurredAt: string; description: string; rawRef: string | null; suggestedCategory: string | null; confidence: number; duplicate: boolean }` and `CommitRow = { amountCents: number; direction: "in"|"out"; occurredAt: string; description: string; rawRef: string | null; categoryName: string | null }`.
  - `createPreviewService(deps)` → `(input: { householdId: number; accountId: number; source: ImportSource; content: string }) => Promise<PreviewRow[]>`.
  - `createCommitService(deps)` → `(input: { householdId: number; accountId: number; rows: CommitRow[]; actorUuid: string }) => Promise<{ importId: string; imported: number; skipped: number }>`.
  - The existing `createImportService` still exported, now delegating to the extracted `parseRows`/`categorizeRows` helpers (same behavior).

- [ ] **Step 1: Write the failing test**

```ts
// src/http/api/imports/import-preview.test.ts
import { describe, expect, it, vi } from "vitest";
import { createCommitService, createPreviewService } from "./import.service.js";

// Minimal fakes matching the deps the services use.
const OFX = `<OFX><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260715<TRNAMT>-45.90<FITID>TX1<NAME>IFOOD</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260716<TRNAMT>3500.00<FITID>TX2<NAME>SALARIO</STMTTRN></OFX>`;

function deps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    deepseek: {
      enabled: true,
      categorizeTransactions: vi.fn(async () => []),
      extractReceipt: vi.fn(async () => []),
      generateInsights: vi.fn(async () => []),
    },
    categoriesRepo: { listVisible: vi.fn(async () => []) },
    transactionsRepo: { create: vi.fn(), createMany: vi.fn(async () => 0) },
    importsRepo: {
      createBatch: vi.fn(async () => ({ id: 1, uuid: "batch-uuid" })),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
      existingRawRefs: vi.fn(async () => new Set(["TX1"])), // TX1 already imported
    },
    ...overrides,
  } as never;
}

describe("previewImport", () => {
  it("parses + flags duplicates and persists NOTHING", async () => {
    const d = deps();
    const preview = createPreviewService(d);
    const rows = await preview({ householdId: 1, accountId: 9, source: "ofx", content: OFX });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.rawRef === "TX1")?.duplicate).toBe(true);
    expect(rows.find((r) => r.rawRef === "TX2")?.duplicate).toBe(false);
    // no batch created, no transactions written during preview:
    expect((d as { importsRepo: { createBatch: { mock: { calls: unknown[] } } } }).importsRepo.createBatch).not.toHaveBeenCalled();
    expect((d as { transactionsRepo: { createMany: { mock: { calls: unknown[] } } } }).transactionsRepo.createMany).not.toHaveBeenCalled();
  });
});

describe("commitImport", () => {
  it("persists only non-duplicate rows and reports skipped", async () => {
    const d = deps();
    const commit = createCommitService(d);
    const res = await commit({
      householdId: 1,
      accountId: 9,
      actorUuid: "actor",
      rows: [
        { amountCents: 4590, direction: "out", occurredAt: "2026-07-15T00:00:00.000Z", description: "iFood", rawRef: "TX1", categoryName: null },
        { amountCents: 350000, direction: "in", occurredAt: "2026-07-16T00:00:00.000Z", description: "Salário", rawRef: "TX2", categoryName: null },
      ],
    });
    // TX1 is an existing rawRef → skipped; only TX2 persisted.
    const createMany = (d as { transactionsRepo: { createMany: { mock: { calls: unknown[][] } } } }).transactionsRepo.createMany;
    expect((createMany.mock.calls[0][0] as unknown[]).length).toBe(1);
    expect(res.skipped).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- import-preview`
Expected: FAIL — `createPreviewService`/`createCommitService` not exported.

- [ ] **Step 3: Write minimal implementation**

Refactor `import.service.ts`. Add the shared helpers and the two services; refactor the existing `createImportService` to use `parseRows`/`categorizeRows`.

```ts
// add near the top-level of import.service.ts (after imports)

export type PreviewRow = {
  amountCents: number;
  direction: "in" | "out";
  occurredAt: string;
  description: string;
  rawRef: string | null;
  suggestedCategory: string | null;
  confidence: number;
  duplicate: boolean;
};

export type CommitRow = {
  amountCents: number;
  direction: "in" | "out";
  occurredAt: string;
  description: string;
  rawRef: string | null;
  categoryName: string | null;
};

async function parseRows(
  source: ImportSource,
  content: string,
  gateway: DeepseekGateway,
): Promise<NormalizedRow[]> {
  if (source === "ofx") return parseOfx(content);
  if (source === "csv") return parseCsv(content);
  const extracted = await gateway.extractReceipt(content);
  return extracted.map((e) => ({
    amountCents: e.amountCents,
    direction: e.direction,
    occurredAt: e.occurredAt ? new Date(e.occurredAt) : new Date(),
    description: e.description.slice(0, 512),
    rawRef: null,
  }));
}

async function categorizeRows(
  householdId: number,
  rows: NormalizedRow[],
  deps: { deepseek: DeepseekGateway; categoriesRepo: CategoriesRepository },
) {
  const categories = await deps.categoriesRepo.listVisible(householdId);
  const byName = new Map(categories.map((c) => [c.name, c]));
  const categorizations = await deps.deepseek.categorizeTransactions({
    categories: categories.map((c) => ({ name: c.name, kind: c.kind })),
    items: rows.map((r, index) => ({
      index,
      description: r.description,
      direction: r.direction,
      amountCents: r.amountCents,
    })),
  });
  return { byName, catByIndex: new Map(categorizations.map((c) => [c.index, c])) };
}

export function createPreviewService(deps: ImportServiceDeps) {
  return async (input: {
    householdId: number;
    accountId: number;
    source: ImportSource;
    content: string;
  }): Promise<PreviewRow[]> => {
    const rows = await parseRows(input.source, input.content, deps.deepseek);
    const refs = rows.map((r) => r.rawRef).filter((r): r is string => r !== null);
    const seen = await deps.importsRepo.existingRawRefs(input.accountId, refs);
    const { catByIndex } = await categorizeRows(input.householdId, rows, deps);
    return rows.map((r, index) => {
      const guess = catByIndex.get(index);
      return {
        amountCents: r.amountCents,
        direction: r.direction,
        occurredAt: r.occurredAt.toISOString(),
        description: r.description,
        rawRef: r.rawRef,
        suggestedCategory: guess?.category ?? null,
        confidence: Math.round(guess?.confidence ?? 0),
        duplicate: r.rawRef !== null && seen.has(r.rawRef),
      };
    });
  };
}

export function createCommitService(deps: ImportServiceDeps) {
  return async (input: {
    householdId: number;
    accountId: number;
    rows: CommitRow[];
    actorUuid: string;
  }): Promise<{ importId: string; imported: number; skipped: number }> => {
    const batch = await deps.importsRepo.createBatch({
      householdId: input.householdId,
      source: "import",
      actorUuid: input.actorUuid,
    });
    try {
      const refs = input.rows.map((r) => r.rawRef).filter((r): r is string => r !== null);
      const seen = await deps.importsRepo.existingRawRefs(input.accountId, refs);
      const fresh = input.rows.filter((r) => r.rawRef === null || !seen.has(r.rawRef));
      const categories = await deps.categoriesRepo.listVisible(input.householdId);
      const byName = new Map(categories.map((c) => [c.name, c]));
      const toInsert: CreateTransactionInput[] = fresh.map((r) => ({
        accountId: input.accountId,
        categoryId: r.categoryName ? (byName.get(r.categoryName)?.id ?? null) : null,
        importBatchId: batch.id,
        amountCents: r.amountCents,
        direction: r.direction,
        occurredAt: new Date(r.occurredAt),
        description: r.description.slice(0, 512),
        source: "import",
        rawRef: r.rawRef,
        aiCategorized: false,
        aiConfidence: null,
        actorUuid: input.actorUuid,
      }));
      const imported = await deps.transactionsRepo.createMany(toInsert);
      await deps.importsRepo.markCompleted(batch.id, imported);
      return { importId: batch.uuid, imported, skipped: input.rows.length - imported };
    } catch (err) {
      await deps.importsRepo.markFailed(batch.id, err instanceof Error ? err.message : "unknown");
      throw err;
    }
  };
}
```

Then refactor the EXISTING `createImportService` body: replace its inline parse block with `const rows = await parseRows(input.source, input.content, deps.deepseek);` and its inline categorize block with `const { byName, catByIndex } = await categorizeRows(input.householdId, fresh, deps);` (keep the dedup-then-categorize-fresh ordering it already has). Behavior must stay identical — the existing import e2e is the guard.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:unit -- import-preview` → PASS (2 tests).
Run: `pnpm test:e2e -- finance` → the existing import e2e STILL passes (refactor didn't change `/imports` behavior).
Run: `pnpm typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/http/api/imports/import.service.ts src/http/api/imports/import-preview.test.ts
git commit -m "feat(imports): extract parse/categorize helpers + preview/commit services"
```

---

### Task 2: Preview + commit routes

**Files:**
- Modify: `src/http/api/imports/imports.schema.ts`
- Modify: `src/http/api/imports/index.ts`
- Test: covered by e2e (Task 3).

**Interfaces:**
- Produces: routes `previewImport` (`POST /imports/preview`) and `commitImport` (`POST /imports/commit`).

- [ ] **Step 1: Add schemas**

```ts
// append to src/http/api/imports/imports.schema.ts
export const PreviewImportBody = z.object({
  source: z.enum(IMPORT_SOURCES),
  accountId: z.uuid(),
  content: z.string().min(1).max(1_000_000),
});

export const PreviewRowView = z.object({
  amountCents: z.number().int(),
  direction: z.enum(["in", "out"]),
  occurredAt: z.string(),
  description: z.string(),
  rawRef: z.string().nullable(),
  suggestedCategory: z.string().nullable(),
  confidence: z.number().int(),
  duplicate: z.boolean(),
});
export const PreviewImportResponse = z.object({ rows: z.array(PreviewRowView) });

export const CommitImportBody = z.object({
  accountId: z.uuid(),
  rows: z.array(
    z.object({
      amountCents: z.number().int(),
      direction: z.enum(["in", "out"]),
      occurredAt: z.string(),
      description: z.string().min(1).max(512),
      rawRef: z.string().nullable(),
      categoryName: z.string().nullable(),
    }),
  ),
});
export const CommitImportResponse = z.object({
  importId: z.uuid(),
  imported: z.number().int(),
  skipped: z.number().int(),
});
```

- [ ] **Step 2: Add the routes**

In `src/http/api/imports/index.ts`, add two routes after the existing `/imports` route (reuse the already-created repos + `requireHousehold`/`requireUser`, and resolve the account by uuid the same way the existing route does):

```ts
  app.withTypeProvider<ZodTypeProvider>().post(
    "/imports/preview",
    {
      preHandler: requireHouseholdRole("adult"),
      schema: {
        operationId: "previewImport",
        tags: ["imports"],
        summary: "Parse + categorize a statement without persisting (review step)",
        body: PreviewImportBody,
        response: { 200: PreviewImportResponse },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      const account = await accountsRepo.findByUuid(hh.id, req.body.accountId);
      if (!account) throw ERRORS.RESOURCE.NOT_FOUND();
      const preview = createPreviewService({
        deepseek: req.server.gateways.deepseek,
        categoriesRepo,
        transactionsRepo,
        importsRepo,
      });
      const rows = await preview({
        householdId: hh.id,
        accountId: account.id,
        source: req.body.source,
        content: req.body.content,
      });
      return reply.code(200).send({ rows });
    },
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    "/imports/commit",
    {
      preHandler: requireHouseholdRole("adult"),
      schema: {
        operationId: "commitImport",
        tags: ["imports"],
        summary: "Persist the reviewed transactions from a preview",
        body: CommitImportBody,
        response: { 201: CommitImportResponse },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      const account = await accountsRepo.findByUuid(hh.id, req.body.accountId);
      if (!account) throw ERRORS.RESOURCE.NOT_FOUND();
      const commit = createCommitService({
        deepseek: req.server.gateways.deepseek,
        categoriesRepo,
        transactionsRepo,
        importsRepo,
      });
      const result = await commit({
        householdId: hh.id,
        accountId: account.id,
        rows: req.body.rows,
        actorUuid: requireUser(req).sub,
      });
      return reply.code(201).send(result);
    },
  );
```

Add the imports at the top of the file: `createPreviewService`, `createCommitService` from `./import.service.js`; `PreviewImportBody`, `PreviewImportResponse`, `CommitImportBody`, `CommitImportResponse` from `./imports.schema.js`. (`accountsRepo`, `categoriesRepo`, `transactionsRepo`, `importsRepo`, `ERRORS`, `requireHousehold`, `requireHouseholdRole`, `requireUser` are already in the module.)

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck` → clean.

- [ ] **Step 4: Commit**

```bash
git add src/http/api/imports/index.ts src/http/api/imports/imports.schema.ts
git commit -m "feat(imports): POST /imports/preview + /imports/commit routes"
```

---

### Task 3: End-to-end tests

**Files:**
- Create: `test/e2e/import-wizard.e2e.test.ts`

- [ ] **Step 1: Write the e2e test**

```ts
// test/e2e/import-wizard.e2e.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "./helpers/app.js";

const OFX = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260715<TRNAMT>-45.90<FITID>TX1<NAME>IFOOD</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260716<TRNAMT>3500.00<FITID>TX2<NAME>SALARIO</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe("import wizard preview+commit e2e (db)", () => {
  let h: TestApp;
  async function login(idToken: string) {
    const res = await h.app.inject({ method: "POST", url: "/auth/google", payload: { idToken } });
    return res.json().accessToken as string;
  }
  beforeAll(async () => { h = await buildTestApp(); }, 120_000);
  afterAll(async () => { await h.close(); });

  it("preview does not persist; commit persists reviewed rows; re-commit dedups", async () => {
    const auth = { authorization: `Bearer ${await login("alice")}` };
    const hh = await h.app.inject({ method: "POST", url: "/households", headers: auth, payload: { name: "Casa", type: "individual" } });
    const householdId = hh.json().id as string;
    const scoped = { ...auth, "x-household-id": householdId };
    const acc = await h.app.inject({ method: "POST", url: "/accounts", headers: scoped, payload: { name: "Nubank", kind: "checking" } });
    const accountId = acc.json().id as string;

    // Preview → 2 rows, none persisted yet.
    const preview = await h.app.inject({ method: "POST", url: "/imports/preview", headers: scoped, payload: { source: "ofx", accountId, content: OFX } });
    expect(preview.statusCode).toBe(200);
    const rows = preview.json().rows;
    expect(rows).toHaveLength(2);
    expect(rows.every((r: { duplicate: boolean }) => r.duplicate === false)).toBe(true);
    const listAfterPreview = await h.app.inject({ method: "GET", url: "/transactions", headers: scoped });
    expect(listAfterPreview.json().transactions).toHaveLength(0); // preview persisted nothing

    // Commit only the first row (user excluded the second).
    const commit = await h.app.inject({
      method: "POST", url: "/imports/commit", headers: scoped,
      payload: { accountId, rows: [{ ...rows[0], categoryName: null }] },
    });
    expect(commit.statusCode).toBe(201);
    expect(commit.json().imported).toBe(1);
    const listAfterCommit = await h.app.inject({ method: "GET", url: "/transactions", headers: scoped });
    expect(listAfterCommit.json().transactions).toHaveLength(1);

    // A second preview now flags the committed row as duplicate.
    const preview2 = await h.app.inject({ method: "POST", url: "/imports/preview", headers: scoped, payload: { source: "ofx", accountId, content: OFX } });
    const dupRow = preview2.json().rows.find((r: { rawRef: string }) => r.rawRef === rows[0].rawRef);
    expect(dupRow.duplicate).toBe(true);

    // Re-committing the same row is skipped (dedup).
    const commit2 = await h.app.inject({ method: "POST", url: "/imports/commit", headers: scoped, payload: { accountId, rows: [{ ...rows[0], categoryName: null }] } });
    expect(commit2.json().imported).toBe(0);
    expect(commit2.json().skipped).toBe(1);
  });
});
```

- [ ] **Step 2: Run e2e + full suite**

Run: `pnpm test:e2e -- import-wizard` → PASS.
Run: `pnpm test:run` → all green.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/import-wizard.e2e.test.ts
git commit -m "test(e2e): import preview (no persist) + commit (dedup, exclusion)"
```

---

### Task 4: Export OpenAPI

**Files:** Modify `../finance-app/api.json`.

- [ ] **Step 1: Gate** — `pnpm test:run` all pass; `pnpm typecheck` clean.
- [ ] **Step 2: Export** — `npx tsx scripts/export-openapi.ts ../finance-app/api.json`; verify `grep -o '"operationId": *"[a-zA-Z]*"' ../finance-app/api.json | grep -iE 'preview|commit'` → `previewImport`, `commitImport`.
- [ ] **Step 3: Commit** — `cd ../finance-app && git add api.json && git commit -m "chore(api): regenerate OpenAPI with import preview/commit"`.

---

## Self-Review

**Spec coverage:**
- Preview (parse+categorize, no persist, flag duplicates) → Task 1 `createPreviewService` + Task 2 route + Task 3 test (asserts 0 persisted after preview). ✓
- Commit (persist reviewed rows, dedup, honor exclusions) → Task 1 `createCommitService` + Task 2 route + Task 3 test (excluded row not persisted, re-commit dedups). ✓
- Keep existing `/imports` → Task 1 refactors it to use shared helpers, guarded by `finance.e2e.test.ts`. ✓
- OpenAPI export for Plan B → Task 4. ✓
- Receipt-photo deferred (not in scope); `preview`/`commit` still accept the `receipt` source for parity but the wizard uses ofx/csv. ✓

**Placeholder scan:** None.

**Type consistency:** `PreviewRow`/`CommitRow` defined in `import.service.ts` (Task 1), mirrored by the Zod views in `imports.schema.ts` (Task 2). `ImportServiceDeps` (existing) is reused by both new services. Account addressed by uuid in bodies, resolved to internal id in the routes (Task 2), passed as `accountId: number` to the services (Task 1) — matching `existingRawRefs(accountId: number, ...)`.

**Confirmed against source:** `existingRawRefs`/`createMany`/`listVisible`/`createBatch`/`markCompleted`/`markFailed` signatures verified; `req.server.gateways.deepseek` accessor and account-uuid resolution match the existing `/imports` route.
