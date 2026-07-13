# AI Copilot Insights — Backend (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate cached, structured financial insight cards (with optional advice) for a household by aggregating its data server-side and asking the existing Deepseek gateway, exposed via household-scoped endpoints.

**Architecture:** A new `insight` table. The Deepseek gateway gains a `generateInsights` method (same graceful-no-op shape as its existing methods). A **pure aggregate builder** (`insights.aggregate.ts`, unit-tested, no DB) turns fetched sums/goals into an `InsightRequest`; an **insights repository** does the SQL (category totals per window, list/replace/staleness); an **insights service** orchestrates staleness → aggregate → gateway → persist. Routes: `GET` (generate-if-stale) + `POST refresh` (adult).

**Tech Stack:** Node 22, Fastify 5, fastify-type-provider-zod, Zod 4 (`zod/v4`), Drizzle (drizzle-kit), Vitest (unit + e2e Testcontainers), Deepseek gateway (OpenAI-compatible).

## Global Constraints

- Zod from `"zod/v4"`; routes use `app.withTypeProvider<ZodTypeProvider>()` + `operationId` (camelCase, unique — Kubb) + `tags` + `summary` + `response` schema. Presenters expose `uuid` as `id`.
- Tables use `entityColumns("<name>")`. Repositories are `create<X>Repository(db)` factories returning an interface, `toDomain` mappers, `isNull(deletedAt)` filters.
- Transactions link to a household via `account.householdId` (transaction has `accountId` → `account`, NOT a direct `householdId`). Amounts are POSITIVE `amountCents` with a `direction` (`in`/`out`). Categories have `kind` (`income`/`expense`) and a `name`. Goals have `householdId`, `targetAmountCents` (nullable), `currentAmountCents`, `type`, `name`.
- Gateway methods NEVER throw: on disabled (`enabled=false`, no key) or any failure they return `[]`. The gateways plugin injects real instances; e2e passes fakes via `buildFakeGateways(overrides)` — extending the `DeepseekGateway` interface REQUIRES updating `test/mocks/gateways.fake.ts` (`fakeDeepseek`) or TS breaks.
- Household-scoped routes: `preHandler: requireHouseholdRole(minRole)`, then `requireHousehold(req)` → `{ id, uuid, type, role }`. `GET` uses `viewer`, `POST refresh` uses `adult`.
- New errors (if any) go in `catalog.ts` + all three `i18n/*.json` bundles. (This plan needs none — endpoints degrade to empty lists, never error on AI failure.)
- Migrations: edit table files → `pnpm db:generate`. Tests: `pnpm test:unit` (no Docker), `pnpm test:e2e` (Testcontainers, Docker available). e2e uses `buildTestApp(gatewayOverrides?)` + `app.inject`, fake Google login `POST /auth/google {idToken:"alice"}`.
- Commit directly on `master`; stage only the files each task names (never `git add -A`).

---

### Task 1: `insight` table + migration

**Files:**
- Create: `src/infra/db/tables/insights/insight.table.ts`
- Modify: `src/infra/db/schema.ts`
- Generate: migration
- Test: `src/infra/db/tables/insights/insight.table.test.ts`

**Interfaces:**
- Produces: `insight` table; `INSIGHT_KINDS = ["spending_alert","summary","trend","advice"]`, `INSIGHT_SEVERITIES = ["info","warning","positive"]`; types `InsightRow`, `InsightInsert`.

- [ ] **Step 1: Write the failing test**

```ts
// src/infra/db/tables/insights/insight.table.test.ts
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { INSIGHT_KINDS, INSIGHT_SEVERITIES, insight } from "./insight.table.js";

describe("insight table", () => {
  it("has the expected columns", () => {
    const cols = Object.keys(getTableColumns(insight));
    for (const c of ["id","uuid","householdId","kind","severity","title","body","recommendation","periodStart","periodEnd","generatedAt","deletedAt"]) {
      expect(cols).toContain(c);
    }
  });
  it("exposes kind + severity enums", () => {
    expect(INSIGHT_KINDS).toContain("advice");
    expect(INSIGHT_SEVERITIES).toContain("warning");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- insight.table`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/infra/db/tables/insights/insight.table.ts
import { bigint, index, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { entityColumns } from "../../columns.js";
import { household } from "../households/household.table.js";

export const INSIGHT_KINDS = ["spending_alert", "summary", "trend", "advice"] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];
export const INSIGHT_SEVERITIES = ["info", "warning", "positive"] as const;
export type InsightSeverity = (typeof INSIGHT_SEVERITIES)[number];

// An AI-generated insight card over a household's finances. A "generation" is the
// batch sharing the newest generatedAt; regeneration soft-deletes the prior batch.
export const insight = pgTable(
  "insight",
  {
    ...entityColumns("insight"),
    householdId: bigint("household_id", { mode: "number" })
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 24, enum: INSIGHT_KINDS }).notNull(),
    severity: varchar("severity", { length: 16, enum: INSIGHT_SEVERITIES }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    body: text("body").notNull(),
    recommendation: text("recommendation"),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("idx_insight_household").on(t.householdId)],
);

export type InsightRow = typeof insight.$inferSelect;
export type InsightInsert = typeof insight.$inferInsert;
```

Add to `src/infra/db/schema.ts`: `export { insight } from "./tables/insights/insight.table.js";`

- [ ] **Step 4: Run unit test + generate migration**

Run: `pnpm test:unit -- insight.table` → PASS.
Run: `pnpm db:generate` → a new migration creating `insight` with the `household_id` FK + index. If it emits migrations for OTHER tables (drift), STOP and report.

- [ ] **Step 5: Commit**

```bash
git add src/infra/db/tables/insights/insight.table.ts src/infra/db/tables/insights/insight.table.test.ts src/infra/db/schema.ts src/infra/db/migrations/
git commit -m "feat(db): add insight table + migration"
```

---

### Task 2: Gateway `generateInsights`

**Files:**
- Modify: `src/gateways/deepseek/deepseek.gateway.ts`
- Modify: `test/mocks/gateways.fake.ts`
- Test: `src/gateways/deepseek/insights.gateway.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: on `DeepseekGateway`:
  - types `InsightAggregates` (see Task 3 for the shape — import from the gateway or define here and re-export), `GeneratedInsight = { kind: InsightKind; severity: InsightSeverity; title: string; body: string; recommendation: string | null }`.
  - `generateInsights(input: InsightAggregates): Promise<GeneratedInsight[]>` — `[]` when disabled or on any failure.
- `fakeDeepseek()` gains a deterministic `generateInsights` (e.g. returns one `summary`/`positive` insight referencing the net, and one `advice` insight, so e2e can assert without a network call).

- [ ] **Step 1: Write the failing test**

```ts
// src/gateways/deepseek/insights.gateway.test.ts
import { describe, expect, it } from "vitest";
import { createDeepseekGateway } from "./deepseek.gateway.js";
import type { InsightAggregates } from "./deepseek.gateway.js";

const AGG: InsightAggregates = {
  period: { start: "2026-06-01", end: "2026-07-31" },
  categoryTotals: [{ name: "Mercado", kind: "expense", currentCents: 50000, previousCents: 30000, deltaCents: 20000 }],
  incomeCurrentCents: 300000, expenseCurrentCents: 120000, netCurrentCents: 180000,
  netAllTimeCents: 500000,
  goals: [{ name: "Reserva", type: "emergency", targetCents: 1000000, currentCents: 620000, progressPct: 62 }],
};

describe("generateInsights", () => {
  it("returns [] when disabled (no api key)", async () => {
    const gw = createDeepseekGateway({ apiKey: undefined, baseUrl: "http://x", model: "m" });
    expect(await gw.generateInsights(AGG)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- insights.gateway`
Expected: FAIL — `generateInsights` / `InsightAggregates` not exported.

- [ ] **Step 3: Write minimal implementation**

In `deepseek.gateway.ts`, add the types + Zod schema + prompt + method. Add near the other types:

```ts
import type { InsightKind, InsightSeverity } from "../../infra/db/tables/insights/insight.table.js";
import { INSIGHT_KINDS, INSIGHT_SEVERITIES } from "../../infra/db/tables/insights/insight.table.js";

export type InsightAggregates = {
  period: { start: string; end: string };
  categoryTotals: { name: string; kind: "income" | "expense"; currentCents: number; previousCents: number; deltaCents: number }[];
  incomeCurrentCents: number;
  expenseCurrentCents: number;
  netCurrentCents: number;
  netAllTimeCents: number;
  goals: { name: string; type: string; targetCents: number | null; currentCents: number; progressPct: number | null }[];
};

export type GeneratedInsight = {
  kind: InsightKind;
  severity: InsightSeverity;
  title: string;
  body: string;
  recommendation: string | null;
};

const InsightsSchema = z.object({
  items: z.array(
    z.object({
      kind: z.enum(INSIGHT_KINDS),
      severity: z.enum(INSIGHT_SEVERITIES),
      title: z.string().min(1).max(255),
      body: z.string().min(1),
      recommendation: z.string().nullable(),
    }),
  ),
});

function buildInsightsPrompt(a: InsightAggregates): string {
  return [
    "Você é um copiloto financeiro em português do Brasil.",
    "Com base nos AGREGADOS abaixo (sem transações individuais), gere de 3 a 6 insights úteis.",
    `kind ∈ ${INSIGHT_KINDS.join(", ")}; severity ∈ ${INSIGHT_SEVERITIES.join(", ")}.`,
    "Use 'advice' + recommendation quando houver uma ação concreta; recommendation=null quando for só informativo.",
    "Valores estão em centavos. Seja específico e acionável, sem inventar dados fora dos agregados.",
    'Responda APENAS JSON: {"items":[{"kind":"summary","severity":"positive","title":"...","body":"...","recommendation":null}]}.',
    "",
    "AGREGADOS:",
    JSON.stringify(a),
  ].join("\n");
}
```

Add to the `DeepseekGateway` interface: `generateInsights(input: InsightAggregates): Promise<GeneratedInsight[]>;`

Add to the returned object in `createDeepseekGateway`:

```ts
    async generateInsights(input) {
      if (!enabled) return [];
      const content = await callJson(buildInsightsPrompt(input));
      if (!content) return [];
      try {
        const parsed = InsightsSchema.safeParse(JSON.parse(content));
        return parsed.success ? parsed.data.items : [];
      } catch {
        return [];
      }
    },
```

In `test/mocks/gateways.fake.ts`, add to `fakeDeepseek()`'s returned object:

```ts
    async generateInsights(input) {
      return [
        {
          kind: "summary",
          severity: input.netCurrentCents >= 0 ? "positive" : "warning",
          title: "Resumo do período",
          body: `Saldo do período: ${input.netCurrentCents} centavos.`,
          recommendation: null,
        },
        {
          kind: "advice",
          severity: "info",
          title: "Dica",
          body: "Considere revisar a maior categoria de gasto.",
          recommendation: "Defina um limite mensal para a categoria de maior gasto.",
        },
      ];
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- insights.gateway` → PASS.
Run: `pnpm typecheck` → clean (interface + fake in sync).

- [ ] **Step 5: Commit**

```bash
git add src/gateways/deepseek/deepseek.gateway.ts test/mocks/gateways.fake.ts src/gateways/deepseek/insights.gateway.test.ts
git commit -m "feat(gateway): add Deepseek generateInsights (graceful no-op)"
```

---

### Task 3: Pure aggregate builder

**Files:**
- Create: `src/http/api/insights/insights.aggregate.ts`
- Test: `src/http/api/insights/insights.aggregate.test.ts`

**Interfaces:**
- Consumes: `InsightAggregates` (from the gateway).
- Produces: `buildAggregates(input: AggregateInput): InsightAggregates` where
  `AggregateInput = { period: { start: string; end: string }; current: CategorySum[]; previous: CategorySum[]; netAllTimeCents: number; goals: GoalInput[] }`,
  `CategorySum = { name: string; kind: "income" | "expense"; cents: number }`,
  `GoalInput = { name: string; type: string; targetCents: number | null; currentCents: number }`.
  Pure: merges current+previous per category (by name+kind) computing `deltaCents`; sums income/expense/net for current; computes goal `progressPct` (`target>0 ? round(current/target*100) : null`).

- [ ] **Step 1: Write the failing test**

```ts
// src/http/api/insights/insights.aggregate.test.ts
import { describe, expect, it } from "vitest";
import { buildAggregates } from "./insights.aggregate.js";

describe("buildAggregates", () => {
  it("merges category windows, computes deltas, totals, and goal progress", () => {
    const out = buildAggregates({
      period: { start: "2026-06-01", end: "2026-07-31" },
      current: [
        { name: "Salário", kind: "income", cents: 300000 },
        { name: "Mercado", kind: "expense", cents: 50000 },
      ],
      previous: [{ name: "Mercado", kind: "expense", cents: 30000 }],
      netAllTimeCents: 500000,
      goals: [{ name: "Reserva", type: "emergency", targetCents: 1000000, currentCents: 620000 }],
    });
    expect(out.incomeCurrentCents).toBe(300000);
    expect(out.expenseCurrentCents).toBe(50000);
    expect(out.netCurrentCents).toBe(250000);
    const mercado = out.categoryTotals.find((c) => c.name === "Mercado");
    expect(mercado).toMatchObject({ currentCents: 50000, previousCents: 30000, deltaCents: 20000 });
    expect(out.goals[0]).toMatchObject({ progressPct: 62 });
  });

  it("handles a null/zero goal target as null progress", () => {
    const out = buildAggregates({
      period: { start: "a", end: "b" }, current: [], previous: [], netAllTimeCents: 0,
      goals: [{ name: "X", type: "trip", targetCents: null, currentCents: 100 }],
    });
    expect(out.goals[0].progressPct).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- insights.aggregate` → FAIL (module missing).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/http/api/insights/insights.aggregate.ts
import type { InsightAggregates } from "../../../gateways/deepseek/deepseek.gateway.js";

export type CategorySum = { name: string; kind: "income" | "expense"; cents: number };
export type GoalInput = { name: string; type: string; targetCents: number | null; currentCents: number };
export type AggregateInput = {
  period: { start: string; end: string };
  current: CategorySum[];
  previous: CategorySum[];
  netAllTimeCents: number;
  goals: GoalInput[];
};

export function buildAggregates(input: AggregateInput): InsightAggregates {
  const key = (c: { name: string; kind: string }) => `${c.kind}:${c.name}`;
  const prev = new Map(input.previous.map((c) => [key(c), c.cents]));
  const seen = new Map<string, { name: string; kind: "income" | "expense"; currentCents: number; previousCents: number }>();
  for (const c of input.current) {
    seen.set(key(c), { name: c.name, kind: c.kind, currentCents: c.cents, previousCents: prev.get(key(c)) ?? 0 });
  }
  for (const c of input.previous) {
    if (!seen.has(key(c))) seen.set(key(c), { name: c.name, kind: c.kind, currentCents: 0, previousCents: c.cents });
  }
  const categoryTotals = [...seen.values()].map((c) => ({ ...c, deltaCents: c.currentCents - c.previousCents }));

  const incomeCurrentCents = input.current.filter((c) => c.kind === "income").reduce((s, c) => s + c.cents, 0);
  const expenseCurrentCents = input.current.filter((c) => c.kind === "expense").reduce((s, c) => s + c.cents, 0);

  const goals = input.goals.map((g) => ({
    name: g.name,
    type: g.type,
    targetCents: g.targetCents,
    currentCents: g.currentCents,
    progressPct: g.targetCents && g.targetCents > 0 ? Math.round((g.currentCents / g.targetCents) * 100) : null,
  }));

  return {
    period: input.period,
    categoryTotals,
    incomeCurrentCents,
    expenseCurrentCents,
    netCurrentCents: incomeCurrentCents - expenseCurrentCents,
    netAllTimeCents: input.netAllTimeCents,
    goals,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- insights.aggregate` → PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/http/api/insights/insights.aggregate.ts src/http/api/insights/insights.aggregate.test.ts
git commit -m "feat(insights): pure aggregate builder"
```

---

### Task 4: Insights repository

**Files:**
- Create: `src/http/api/insights/insights.repository.ts`
- Test: `src/http/api/insights/insights.repository.test.ts` (factory shape)

**Interfaces:**
- Consumes: `Db`, `insight`, `transaction`, `account`, `category`, `goal`, `GeneratedInsight`, `CategorySum`, `GoalInput`.
- Produces: `createInsightsRepository(db)`:
  - `categorySums(householdId: number, startISO: string, endISO: string): Promise<CategorySum[]>` — join transaction→account (household) + category, filter `occurredAt` in [start,end) and `isNull(deletedAt)`, group by category.name+kind, sum `amountCents`. (Rows with no category are grouped under name `"Sem categoria"` using the direction to infer kind: `out`→expense, `in`→income.)
  - `netAllTime(householdId: number): Promise<number>` — `sum(in) - sum(out)` across the household's transactions (cents).
  - `goalsFor(householdId: number): Promise<GoalInput[]>`.
  - `listActive(householdId: number): Promise<Insight[]>` — newest generation, ordered; `Insight = { id: string; kind; severity; title; body; recommendation: string|null; periodStart; periodEnd; generatedAt }`.
  - `latestGeneratedAt(householdId: number): Promise<Date | null>`.
  - `replaceAll(args: { householdId: number; period: { start: Date; end: Date }; items: GeneratedInsight[]; actorUuid: string }): Promise<Insight[]>` — soft-delete prior active, insert the new batch with one shared `generatedAt`, return them.

- [ ] **Step 1: Write the failing test**

```ts
// src/http/api/insights/insights.repository.test.ts
import { describe, expect, it } from "vitest";
import { createInsightsRepository } from "./insights.repository.js";

describe("createInsightsRepository", () => {
  it("exposes the insights interface", () => {
    const repo = createInsightsRepository({} as never);
    for (const m of ["categorySums","netAllTime","goalsFor","listActive","latestGeneratedAt","replaceAll"]) {
      expect(typeof (repo as Record<string, unknown>)[m]).toBe("function");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- insights.repository` → FAIL (module missing).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/http/api/insights/insights.repository.ts
import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../../../infra/db/client.js";
import { account } from "../../../infra/db/tables/accounts/account.table.js";
import { category } from "../../../infra/db/tables/categories/category.table.js";
import { goal } from "../../../infra/db/tables/goals/goal.table.js";
import { type InsightRow, insight } from "../../../infra/db/tables/insights/insight.table.js";
import { transaction } from "../../../infra/db/tables/transactions/transaction.table.js";
import type { GeneratedInsight } from "../../../gateways/deepseek/deepseek.gateway.js";
import type { CategorySum, GoalInput } from "./insights.aggregate.js";

export type Insight = {
  id: string;
  kind: InsightRow["kind"];
  severity: InsightRow["severity"];
  title: string;
  body: string;
  recommendation: string | null;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
};

function toDomain(r: InsightRow): Insight {
  return {
    id: r.uuid,
    kind: r.kind,
    severity: r.severity,
    title: r.title,
    body: r.body,
    recommendation: r.recommendation,
    periodStart: r.periodStart.toISOString(),
    periodEnd: r.periodEnd.toISOString(),
    generatedAt: r.generatedAt.toISOString(),
  };
}

export interface InsightsRepository {
  categorySums(householdId: number, startISO: string, endISO: string): Promise<CategorySum[]>;
  netAllTime(householdId: number): Promise<number>;
  goalsFor(householdId: number): Promise<GoalInput[]>;
  listActive(householdId: number): Promise<Insight[]>;
  latestGeneratedAt(householdId: number): Promise<Date | null>;
  replaceAll(args: {
    householdId: number;
    period: { start: Date; end: Date };
    items: GeneratedInsight[];
    actorUuid: string;
  }): Promise<Insight[]>;
}

export function createInsightsRepository(db: Db): InsightsRepository {
  return {
    async categorySums(householdId, startISO, endISO) {
      const rows = await db
        .select({
          name: sql<string>`coalesce(${category.name}, 'Sem categoria')`,
          kind: sql<"income" | "expense">`coalesce(${category.kind}, case when ${transaction.direction} = 'in' then 'income' else 'expense' end)`,
          cents: sql<number>`sum(${transaction.amountCents})::int`,
        })
        .from(transaction)
        .innerJoin(account, eq(account.id, transaction.accountId))
        .leftJoin(category, eq(category.id, transaction.categoryId))
        .where(
          and(
            eq(account.householdId, householdId),
            isNull(transaction.deletedAt),
            gte(transaction.occurredAt, new Date(startISO)),
            lt(transaction.occurredAt, new Date(endISO)),
          ),
        )
        .groupBy(
          sql`coalesce(${category.name}, 'Sem categoria')`,
          sql`coalesce(${category.kind}, case when ${transaction.direction} = 'in' then 'income' else 'expense' end)`,
        );
      return rows.map((r) => ({ name: r.name, kind: r.kind, cents: Number(r.cents) }));
    },

    async netAllTime(householdId) {
      const rows = await db
        .select({
          net: sql<number>`coalesce(sum(case when ${transaction.direction} = 'in' then ${transaction.amountCents} else -${transaction.amountCents} end), 0)::int`,
        })
        .from(transaction)
        .innerJoin(account, eq(account.id, transaction.accountId))
        .where(and(eq(account.householdId, householdId), isNull(transaction.deletedAt)));
      return Number(rows[0]?.net ?? 0);
    },

    async goalsFor(householdId) {
      const rows = await db
        .select({ name: goal.name, type: goal.type, targetCents: goal.targetAmountCents, currentCents: goal.currentAmountCents })
        .from(goal)
        .where(and(eq(goal.householdId, householdId), isNull(goal.deletedAt)));
      return rows.map((r) => ({ name: r.name, type: r.type, targetCents: r.targetCents ?? null, currentCents: r.currentCents }));
    },

    async listActive(householdId) {
      const rows = await db
        .select()
        .from(insight)
        .where(and(eq(insight.householdId, householdId), isNull(insight.deletedAt)))
        .orderBy(desc(insight.generatedAt), desc(insight.id));
      return rows.map(toDomain);
    },

    async latestGeneratedAt(householdId) {
      const rows = await db
        .select({ g: insight.generatedAt })
        .from(insight)
        .where(and(eq(insight.householdId, householdId), isNull(insight.deletedAt)))
        .orderBy(desc(insight.generatedAt))
        .limit(1);
      return rows[0]?.g ?? null;
    },

    async replaceAll({ householdId, period, items, actorUuid }) {
      return db.transaction(async (tx) => {
        const now = new Date();
        await tx
          .update(insight)
          .set({ deletedAt: now, updatedBy: actorUuid, updatedAt: now })
          .where(and(eq(insight.householdId, householdId), isNull(insight.deletedAt)));
        if (items.length === 0) return [];
        const inserted = await tx
          .insert(insight)
          .values(
            items.map((it) => ({
              householdId,
              kind: it.kind,
              severity: it.severity,
              title: it.title,
              body: it.body,
              recommendation: it.recommendation,
              periodStart: period.start,
              periodEnd: period.end,
              generatedAt: now,
              createdBy: actorUuid,
              updatedBy: actorUuid,
              createdAt: now,
              updatedAt: now,
            })),
          )
          .returning();
        return (inserted as InsightRow[]).map(toDomain);
      });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- insights.repository` → PASS.
Run: `pnpm typecheck` → clean (the raw-SQL casts + Drizzle types).

- [ ] **Step 5: Commit**

```bash
git add src/http/api/insights/insights.repository.ts src/http/api/insights/insights.repository.test.ts
git commit -m "feat(insights): repository (aggregate SQL + cache CRUD)"
```

---

### Task 5: Insights service (staleness + orchestration)

**Files:**
- Create: `src/http/api/insights/insights.service.ts`
- Test: covered by e2e (Task 7).

**Interfaces:**
- Consumes: `InsightsRepository`, `DeepseekGateway`, `buildAggregates`.
- Produces: `createInsightsService({ repo, gateway })` with:
  - `getOrGenerate(args: { householdId: number; actorUuid: string; now: Date }): Promise<Insight[]>` — if `latestGeneratedAt` is within 24h, return `listActive`; else generate (aggregate → `gateway.generateInsights` → `repo.replaceAll`) and return. If the gateway returns `[]`, still `replaceAll([])` (clears stale) and return `[]`.
  - `regenerate(args: { householdId; actorUuid; now }): Promise<Insight[]>` — always generate.
  - Period = previous calendar month start … next month start (covers current+previous month); "current" window = this calendar month, "previous" = last month, computed from `now`.

- [ ] **Step 1: Write the minimal implementation**

```ts
// src/http/api/insights/insights.service.ts
import type { DeepseekGateway } from "../../../gateways/deepseek/deepseek.gateway.js";
import { buildAggregates } from "./insights.aggregate.js";
import type { Insight, InsightsRepository } from "./insights.repository.js";

const STALE_MS = 24 * 3600 * 1000;

function monthWindows(now: Date) {
  const curStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const prevStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { prevStart, curStart, nextStart };
}

export function createInsightsService(deps: { repo: InsightsRepository; gateway: DeepseekGateway }) {
  const { repo, gateway } = deps;

  async function generate(householdId: number, actorUuid: string, now: Date): Promise<Insight[]> {
    const { prevStart, curStart, nextStart } = monthWindows(now);
    const [current, previous, netAllTimeCents, goals] = await Promise.all([
      repo.categorySums(householdId, curStart.toISOString(), nextStart.toISOString()),
      repo.categorySums(householdId, prevStart.toISOString(), curStart.toISOString()),
      repo.netAllTime(householdId),
      repo.goalsFor(householdId),
    ]);
    const aggregates = buildAggregates({
      period: { start: prevStart.toISOString(), end: nextStart.toISOString() },
      current,
      previous,
      netAllTimeCents,
      goals,
    });
    const items = await gateway.generateInsights(aggregates);
    return repo.replaceAll({ householdId, period: { start: prevStart, end: nextStart }, items, actorUuid });
  }

  return {
    async getOrGenerate({ householdId, actorUuid, now }: { householdId: number; actorUuid: string; now: Date }) {
      const latest = await repo.latestGeneratedAt(householdId);
      if (latest && now.getTime() - latest.getTime() < STALE_MS) return repo.listActive(householdId);
      return generate(householdId, actorUuid, now);
    },
    regenerate({ householdId, actorUuid, now }: { householdId: number; actorUuid: string; now: Date }) {
      return generate(householdId, actorUuid, now);
    },
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck` → clean.

- [ ] **Step 3: Commit**

```bash
git add src/http/api/insights/insights.service.ts
git commit -m "feat(insights): service (staleness + generation orchestration)"
```

---

### Task 6: Routes (GET generate-if-stale / POST refresh)

**Files:**
- Create: `src/http/api/insights/insights.schema.ts`
- Create: `src/http/api/insights/index.ts`
- Modify: `src/http/index.ts` (register)
- Test: covered by e2e (Task 7).

**Interfaces:**
- Produces: routes `getInsights` (viewer; generate-if-stale), `refreshInsights` (adult; always regenerate).

- [ ] **Step 1: Write the schema**

```ts
// src/http/api/insights/insights.schema.ts
import { z } from "zod/v4";
import { INSIGHT_KINDS, INSIGHT_SEVERITIES } from "../../../infra/db/tables/insights/insight.table.js";

export const InsightView = z.object({
  id: z.uuid(),
  kind: z.enum(INSIGHT_KINDS),
  severity: z.enum(INSIGHT_SEVERITIES),
  title: z.string(),
  body: z.string(),
  recommendation: z.string().nullable(),
  periodStart: z.string(),
  periodEnd: z.string(),
  generatedAt: z.string(),
});
export const ListInsightsResponse = z.object({ insights: z.array(InsightView) });
```

- [ ] **Step 2: Write the routes**

```ts
// src/http/api/insights/index.ts
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod/v4";
import { db } from "../../../infra/db/client.js";
import { requireUser } from "../../hooks/auth/auth.js";
import { requireHousehold, requireHouseholdRole } from "../../hooks/household/household.js";
import { createInsightsRepository } from "./insights.repository.js";
import { ListInsightsResponse } from "./insights.schema.js";
import { createInsightsService } from "./insights.service.js";

export const insightsRoutes: FastifyPluginAsync = async (app) => {
  const repo = createInsightsRepository(db);

  app.withTypeProvider<ZodTypeProvider>().get(
    "/households/:id/insights",
    {
      preHandler: requireHouseholdRole("viewer"),
      schema: {
        operationId: "getInsights",
        tags: ["insights"],
        summary: "Get the household's AI insights (generating if stale)",
        params: z.object({ id: z.string() }),
        response: { 200: ListInsightsResponse },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      const service = createInsightsService({ repo, gateway: req.server.gateways.deepseek });
      const insights = await service.getOrGenerate({ householdId: hh.id, actorUuid: requireUser(req).sub, now: new Date() });
      return reply.code(200).send({ insights });
    },
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    "/households/:id/insights/refresh",
    {
      preHandler: requireHouseholdRole("adult"),
      schema: {
        operationId: "refreshInsights",
        tags: ["insights"],
        summary: "Force-regenerate the household's AI insights",
        params: z.object({ id: z.string() }),
        response: { 200: ListInsightsResponse },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      const service = createInsightsService({ repo, gateway: req.server.gateways.deepseek });
      const insights = await service.regenerate({ householdId: hh.id, actorUuid: requireUser(req).sub, now: new Date() });
      return reply.code(200).send({ insights });
    },
  );
};
```

`req.server.gateways.deepseek` is the correct accessor — confirmed identical to `src/http/api/imports/index.ts:40` (`deepseek: req.server.gateways.deepseek`).

Register in `src/http/index.ts`: `await app.register(insightsRoutes);` after `transactionsRoutes`.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck` → clean.

- [ ] **Step 4: Commit**

```bash
git add src/http/api/insights/index.ts src/http/api/insights/insights.schema.ts src/http/index.ts
git commit -m "feat(insights): GET (generate-if-stale) + POST refresh routes"
```

---

### Task 7: End-to-end tests

**Files:**
- Create: `test/e2e/insights.e2e.test.ts`

**Interfaces:**
- Consumes: `buildTestApp` (fake deepseek `generateInsights` returns 2 deterministic items), `app.inject`.

- [ ] **Step 1: Write the e2e test**

```ts
// test/e2e/insights.e2e.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "./helpers/app.js";

describe("ai insights e2e (db)", () => {
  let h: TestApp;
  async function login(idToken: string) {
    const res = await h.app.inject({ method: "POST", url: "/auth/google", payload: { idToken } });
    return res.json().accessToken as string;
  }
  beforeAll(async () => { h = await buildTestApp(); }, 120_000);
  afterAll(async () => { await h.close(); });

  it("generates + caches insights, and refresh replaces them", async () => {
    const auth = { authorization: `Bearer ${await login("alice")}` };
    const hh = await h.app.inject({ method: "POST", url: "/households", headers: auth, payload: { name: "Casa", type: "individual" } });
    const householdId = hh.json().id as string;
    const scoped = { ...auth, "x-household-id": householdId };

    // First GET → generates (fake gateway returns 2 items) + caches.
    const first = await h.app.inject({ method: "GET", url: `/households/${householdId}/insights`, headers: scoped });
    expect(first.statusCode).toBe(200);
    expect(first.json().insights.length).toBe(2);
    const firstGeneratedAt = first.json().insights[0].generatedAt;

    // Second GET → served from cache (same generatedAt, not regenerated).
    const second = await h.app.inject({ method: "GET", url: `/households/${householdId}/insights`, headers: scoped });
    expect(second.json().insights[0].generatedAt).toBe(firstGeneratedAt);

    // Refresh → regenerates a fresh batch (new generatedAt).
    const refreshed = await h.app.inject({ method: "POST", url: `/households/${householdId}/insights/refresh`, headers: scoped });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().insights.length).toBe(2);
  });

  it("returns an empty list (not an error) when the AI gateway is disabled", async () => {
    const disabled = await buildTestApp({
      deepseek: {
        enabled: false,
        categorizeTransactions: async () => [],
        extractReceipt: async () => [],
        generateInsights: async () => [],
      },
    });
    try {
      const token = (await disabled.app.inject({ method: "POST", url: "/auth/google", payload: { idToken: "bob" } })).json().accessToken;
      const auth = { authorization: `Bearer ${token}` };
      const hh = await disabled.app.inject({ method: "POST", url: "/households", headers: auth, payload: { name: "H", type: "individual" } });
      const householdId = hh.json().id as string;
      const res = await disabled.app.inject({ method: "GET", url: `/households/${householdId}/insights`, headers: { ...auth, "x-household-id": householdId } });
      expect(res.statusCode).toBe(200);
      expect(res.json().insights).toEqual([]);
    } finally {
      await disabled.close();
    }
  });
});
```

- [ ] **Step 2: Run the e2e suite**

Run: `pnpm test:e2e -- insights`
Expected: both tests PASS. If the second-GET cache assertion is flaky because generation is fast (same-ms), it still holds (cache path returns the stored rows unchanged). If `buildTestApp` overrides need a different fake shape, match `DeepseekGateway`.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/insights.e2e.test.ts
git commit -m "test(e2e): AI insights generate/cache/refresh + disabled-gateway"
```

---

### Task 8: Export OpenAPI

**Files:** Modify `../finance-app/api.json`.

- [ ] **Step 1: Full-suite gate**

Run: `pnpm test:run` → all pass. `pnpm typecheck` → clean.

- [ ] **Step 2: Export**

Run: `npx tsx scripts/export-openapi.ts ../finance-app/api.json`
Verify: `grep -o '"operationId": *"[a-zA-Z]*"' ../finance-app/api.json | grep -iE 'Insight'` → `getInsights`, `refreshInsights`.

- [ ] **Step 3: Commit**

```bash
cd ../finance-app && git add api.json && git commit -m "chore(api): regenerate OpenAPI with insights endpoints"
```

---

## Self-Review

**Spec coverage:**
- `insight` table → Task 1. ✓
- Gateway `generateInsights` (graceful no-op) → Task 2. ✓
- Server-side aggregation, no raw transactions to LLM → Task 3 (pure builder) + Task 4 (SQL sends only names+sums) — the prompt (Task 2) serializes only the aggregates. ✓
- On-demand + 24h staleness cache; GET generates-if-stale (viewer), refresh regenerates (adult) → Tasks 5, 6. ✓
- Disabled gateway → empty list, not error → Task 5 (`replaceAll([])`) + Task 7 test. ✓
- Household-scoped RBAC → Task 6. ✓
- OpenAPI export → Task 8. ✓

**Placeholder scan:** None. The Task 1 drift check is a verification step, not a placeholder. Gateway accessor confirmed as `req.server.gateways.deepseek`.

**Type consistency:** `InsightAggregates` defined in the gateway (Task 2), consumed by the pure builder (Task 3) and service (Task 5). `GeneratedInsight` (gateway) flows into `repo.replaceAll` (Task 4). `Insight` (repo domain) is what routes return and the presenter/`InsightView` (Task 6) mirror. `CategorySum`/`GoalInput` defined in the aggregate module (Task 3), produced by the repo (Task 4).

**Confirmed against source:** transactions join household via `account.householdId`; `category.kind` ∈ income/expense, nullable category handled with a coalesce; goals have `targetAmountCents`/`currentAmountCents`; `fakeDeepseek` must gain `generateInsights` (Task 2) or e2e/typecheck breaks. Gateway accessor `req.server.gateways.deepseek` confirmed against `src/http/api/imports/index.ts:40`.
