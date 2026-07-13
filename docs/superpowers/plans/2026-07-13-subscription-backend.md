# Subscription — Backend (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-household subscription state (`free`/`premium`) + a static entitlements map, exposed via GET + stub activate/cancel endpoints.

**Architecture:** New `subscription` table; a pure `entitlements.ts` (plan→entitlements); a repository (get/upsert/cancel); household-scoped routes. No real payment provider (stub).

**Tech Stack:** Node 22, Fastify 5, Zod 4 (`zod/v4`), Drizzle, Vitest (unit + e2e Testcontainers).

## Global Constraints

- Zod from `"zod/v4"`; routes use `withTypeProvider<ZodTypeProvider>()` + unique camelCase `operationId` + `tags` + `summary` + `response`. Presenter exposes `uuid` as `id`.
- `entityColumns("subscription")`. Repository factory pattern + `toDomain`, `isNull(deletedAt)` filters.
- Household-scoped: `requireHouseholdRole(minRole)` + `requireHousehold(req)`; `requireUser(req).sub` = actor uuid.
- Unit tests get dummy env via `test/unit-setup.ts` (wired). Tests: `pnpm test:unit`, `pnpm test:e2e` (Docker up). e2e uses `buildTestApp()` + `app.inject`, fake login `POST /auth/google {idToken}`.
- Commit on `master`; stage only each task's files (never `git add -A`).

---

### Task 1: `subscription` table + migration

**Files:** Create `src/infra/db/tables/subscriptions/subscription.table.ts`; Modify `src/infra/db/schema.ts`; generate migration; Test `.../subscription.table.test.ts`.

**Interfaces:** `SUBSCRIPTION_PLANS=["free","premium"]`, `SUBSCRIPTION_STATUSES=["active","canceled","expired"]`; `subscription` table; `SubscriptionRow`/`Insert`.

- [ ] **Step 1: failing test**

```ts
// src/infra/db/tables/subscriptions/subscription.table.test.ts
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { SUBSCRIPTION_PLANS, subscription } from "./subscription.table.js";
describe("subscription table", () => {
  it("has expected columns", () => {
    const cols = Object.keys(getTableColumns(subscription));
    for (const c of ["id","uuid","householdId","plan","status","provider","providerRef","currentPeriodEnd","deletedAt"]) expect(cols).toContain(c);
  });
  it("exposes plans", () => { expect(SUBSCRIPTION_PLANS).toContain("premium"); });
});
```

- [ ] **Step 2: RED** — `pnpm test:unit -- subscription.table` (module missing).
- [ ] **Step 3: implement**

```ts
// src/infra/db/tables/subscriptions/subscription.table.ts
import { bigint, index, pgTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { entityColumns } from "../../columns.js";
import { household } from "../households/household.table.js";

export const SUBSCRIPTION_PLANS = ["free", "premium"] as const;
export type SubscriptionPlan = (typeof SUBSCRIPTION_PLANS)[number];
export const SUBSCRIPTION_STATUSES = ["active", "canceled", "expired"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const subscription = pgTable(
  "subscription",
  {
    ...entityColumns("subscription"),
    householdId: bigint("household_id", { mode: "number" }).notNull().references(() => household.id, { onDelete: "cascade" }),
    plan: varchar("plan", { length: 16, enum: SUBSCRIPTION_PLANS }).notNull(),
    status: varchar("status", { length: 16, enum: SUBSCRIPTION_STATUSES }).notNull(),
    provider: varchar("provider", { length: 16 }).notNull().default("stub"),
    providerRef: varchar("provider_ref", { length: 255 }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("uq_subscription_household").on(t.householdId).where(sql`${t.deletedAt} is null`),
    index("idx_subscription_household").on(t.householdId),
  ],
);
export type SubscriptionRow = typeof subscription.$inferSelect;
export type SubscriptionInsert = typeof subscription.$inferInsert;
```

Add to `schema.ts`: `export { subscription } from "./tables/subscriptions/subscription.table.js";`

- [ ] **Step 4: GREEN + migration** — `pnpm test:unit -- subscription.table` PASS; `pnpm db:generate` (verify single new migration for `subscription` w/ partial unique index; if drift on other tables, STOP + report).
- [ ] **Step 5: commit**

```bash
git add src/infra/db/tables/subscriptions/subscription.table.ts src/infra/db/tables/subscriptions/subscription.table.test.ts src/infra/db/schema.ts src/infra/db/migrations/
git commit -m "feat(db): add subscription table + migration"
```

---

### Task 2: entitlements config (pure)

**Files:** Create `src/domain/entitlements.ts`; Test `src/domain/entitlements.test.ts`.

**Interfaces:** `type Entitlements = { aiInsights: boolean; futureProjection: boolean; unlimitedContexts: boolean; maxContexts: number }`; `PLAN_ENTITLEMENTS: Record<SubscriptionPlan, Entitlements>`; `entitlementsFor(plan: SubscriptionPlan, status: SubscriptionStatus): Entitlements` (canceled/expired → free).

- [ ] **Step 1: failing test**

```ts
// src/domain/entitlements.test.ts
import { describe, expect, it } from "vitest";
import { entitlementsFor } from "./entitlements.js";
describe("entitlementsFor", () => {
  it("premium active unlocks features", () => {
    const e = entitlementsFor("premium", "active");
    expect(e.aiInsights).toBe(true);
    expect(e.futureProjection).toBe(true);
    expect(e.maxContexts).toBeGreaterThan(100);
  });
  it("free is limited", () => {
    expect(entitlementsFor("free", "active").aiInsights).toBe(false);
    expect(entitlementsFor("free", "active").maxContexts).toBe(2);
  });
  it("canceled premium reverts to free", () => {
    expect(entitlementsFor("premium", "canceled").aiInsights).toBe(false);
  });
});
```

- [ ] **Step 2: RED** — `pnpm test:unit -- entitlements`.
- [ ] **Step 3: implement**

```ts
// src/domain/entitlements.ts
import type { SubscriptionPlan, SubscriptionStatus } from "../infra/db/tables/subscriptions/subscription.table.js";

export type Entitlements = {
  aiInsights: boolean;
  futureProjection: boolean;
  unlimitedContexts: boolean;
  maxContexts: number;
};

export const PLAN_ENTITLEMENTS: Record<SubscriptionPlan, Entitlements> = {
  free: { aiInsights: false, futureProjection: false, unlimitedContexts: false, maxContexts: 2 },
  premium: { aiInsights: true, futureProjection: true, unlimitedContexts: true, maxContexts: 9999 },
};

export function entitlementsFor(plan: SubscriptionPlan, status: SubscriptionStatus): Entitlements {
  if (status !== "active") return PLAN_ENTITLEMENTS.free;
  return PLAN_ENTITLEMENTS[plan];
}
```

- [ ] **Step 4: GREEN** — `pnpm test:unit -- entitlements` PASS (3).
- [ ] **Step 5: commit**

```bash
git add src/domain/entitlements.ts src/domain/entitlements.test.ts
git commit -m "feat(subscription): plan entitlements config"
```

---

### Task 3: subscriptions repository

**Files:** Create `src/http/api/subscriptions/subscriptions.repository.ts`; Test `.../subscriptions.repository.test.ts` (factory shape).

**Interfaces:** `createSubscriptionsRepository(db)`:
- `getForHousehold(householdId: number): Promise<Subscription | null>` — `Subscription = { id: string; plan: SubscriptionPlan; status: SubscriptionStatus; currentPeriodEnd: string | null }`.
- `upsertActive(args: { householdId: number; plan: SubscriptionPlan; currentPeriodEnd: Date; actorUuid: string }): Promise<Subscription>` — insert or update the household's row to `{plan, status:'active', provider:'stub', currentPeriodEnd, deletedAt:null}`.
- `cancel(args: { householdId: number; actorUuid: string }): Promise<Subscription | null>` — set `status:'canceled'`; return updated (or null if none).

- [ ] **Step 1: failing test** (factory shape — behavior in e2e)

```ts
// src/http/api/subscriptions/subscriptions.repository.test.ts
import { describe, expect, it } from "vitest";
import { createSubscriptionsRepository } from "./subscriptions.repository.js";
describe("createSubscriptionsRepository", () => {
  it("exposes the interface", () => {
    const r = createSubscriptionsRepository({} as never);
    for (const m of ["getForHousehold","upsertActive","cancel"]) expect(typeof (r as Record<string, unknown>)[m]).toBe("function");
  });
});
```

- [ ] **Step 2: RED** — `pnpm test:unit -- subscriptions.repository`.
- [ ] **Step 3: implement**

```ts
// src/http/api/subscriptions/subscriptions.repository.ts
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../../infra/db/client.js";
import {
  type SubscriptionPlan,
  type SubscriptionRow,
  type SubscriptionStatus,
  subscription,
} from "../../../infra/db/tables/subscriptions/subscription.table.js";

export type Subscription = {
  id: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  currentPeriodEnd: string | null;
};

function toDomain(r: SubscriptionRow): Subscription {
  return { id: r.uuid, plan: r.plan, status: r.status, currentPeriodEnd: r.currentPeriodEnd?.toISOString() ?? null };
}

export interface SubscriptionsRepository {
  getForHousehold(householdId: number): Promise<Subscription | null>;
  upsertActive(args: { householdId: number; plan: SubscriptionPlan; currentPeriodEnd: Date; actorUuid: string }): Promise<Subscription>;
  cancel(args: { householdId: number; actorUuid: string }): Promise<Subscription | null>;
}

export function createSubscriptionsRepository(db: Db): SubscriptionsRepository {
  async function current(householdId: number): Promise<SubscriptionRow | null> {
    const rows = await db.select().from(subscription)
      .where(and(eq(subscription.householdId, householdId), isNull(subscription.deletedAt))).limit(1);
    return rows[0] ?? null;
  }
  return {
    async getForHousehold(householdId) {
      const row = await current(householdId);
      return row ? toDomain(row) : null;
    },
    async upsertActive({ householdId, plan, currentPeriodEnd, actorUuid }) {
      const now = new Date();
      const existing = await current(householdId);
      if (existing) {
        const updated = await db.update(subscription)
          .set({ plan, status: "active", provider: "stub", currentPeriodEnd, updatedBy: actorUuid, updatedAt: now })
          .where(eq(subscription.id, existing.id)).returning();
        return toDomain(updated[0] as SubscriptionRow);
      }
      const inserted = await db.insert(subscription).values({
        householdId, plan, status: "active", provider: "stub", currentPeriodEnd,
        createdBy: actorUuid, updatedBy: actorUuid, createdAt: now, updatedAt: now,
      }).returning();
      return toDomain(inserted[0] as SubscriptionRow);
    },
    async cancel({ householdId, actorUuid }) {
      const existing = await current(householdId);
      if (!existing) return null;
      const updated = await db.update(subscription)
        .set({ status: "canceled", updatedBy: actorUuid, updatedAt: new Date() })
        .where(eq(subscription.id, existing.id)).returning();
      return toDomain(updated[0] as SubscriptionRow);
    },
  };
}
```

- [ ] **Step 4: GREEN + typecheck** — `pnpm test:unit -- subscriptions.repository` PASS; `pnpm typecheck` clean.
- [ ] **Step 5: commit**

```bash
git add src/http/api/subscriptions/subscriptions.repository.ts src/http/api/subscriptions/subscriptions.repository.test.ts
git commit -m "feat(subscription): repository (get/upsert/cancel)"
```

---

### Task 4: routes (get/activate/cancel)

**Files:** Create `src/http/api/subscriptions/subscriptions.schema.ts`, `src/http/api/subscriptions/index.ts`; Modify `src/http/index.ts`; Test: e2e (Task 5).

**Interfaces:** routes `getSubscription`, `activateSubscription`, `cancelSubscription`.

- [ ] **Step 1: schema**

```ts
// src/http/api/subscriptions/subscriptions.schema.ts
import { z } from "zod/v4";
import { SUBSCRIPTION_PLANS, SUBSCRIPTION_STATUSES } from "../../../infra/db/tables/subscriptions/subscription.table.js";

export const EntitlementsView = z.object({
  aiInsights: z.boolean(),
  futureProjection: z.boolean(),
  unlimitedContexts: z.boolean(),
  maxContexts: z.number().int(),
});
export const SubscriptionView = z.object({
  plan: z.enum(SUBSCRIPTION_PLANS),
  status: z.enum(SUBSCRIPTION_STATUSES),
  currentPeriodEnd: z.string().nullable(),
  entitlements: EntitlementsView,
});
```

- [ ] **Step 2: routes**

```ts
// src/http/api/subscriptions/index.ts
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod/v4";
import { db } from "../../../infra/db/client.js";
import { entitlementsFor } from "../../../domain/entitlements.js";
import { requireUser } from "../../hooks/auth/auth.js";
import { requireHousehold, requireHouseholdRole } from "../../hooks/household/household.js";
import { createSubscriptionsRepository } from "./subscriptions.repository.js";
import { SubscriptionView } from "./subscriptions.schema.js";

export const subscriptionsRoutes: FastifyPluginAsync = async (app) => {
  const repo = createSubscriptionsRepository(db);
  const present = (plan: "free" | "premium", status: "active" | "canceled" | "expired", periodEnd: string | null) => ({
    plan, status, currentPeriodEnd: periodEnd, entitlements: entitlementsFor(plan, status),
  });

  app.withTypeProvider<ZodTypeProvider>().get("/households/:id/subscription", {
    preHandler: requireHouseholdRole("viewer"),
    schema: { operationId: "getSubscription", tags: ["subscriptions"], summary: "Get subscription + entitlements", params: z.object({ id: z.string() }), response: { 200: SubscriptionView } },
  }, async (req, reply) => {
    const hh = requireHousehold(req);
    const sub = await repo.getForHousehold(hh.id);
    if (!sub) return reply.code(200).send(present("free", "active", null));
    return reply.code(200).send(present(sub.plan, sub.status, sub.currentPeriodEnd));
  });

  app.withTypeProvider<ZodTypeProvider>().post("/households/:id/subscription/activate", {
    preHandler: requireHouseholdRole("owner"),
    schema: { operationId: "activateSubscription", tags: ["subscriptions"], summary: "Activate premium (stub)", params: z.object({ id: z.string() }), response: { 200: SubscriptionView } },
  }, async (req, reply) => {
    const hh = requireHousehold(req);
    const periodEnd = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const sub = await repo.upsertActive({ householdId: hh.id, plan: "premium", currentPeriodEnd: periodEnd, actorUuid: requireUser(req).sub });
    return reply.code(200).send(present(sub.plan, sub.status, sub.currentPeriodEnd));
  });

  app.withTypeProvider<ZodTypeProvider>().post("/households/:id/subscription/cancel", {
    preHandler: requireHouseholdRole("owner"),
    schema: { operationId: "cancelSubscription", tags: ["subscriptions"], summary: "Cancel subscription", params: z.object({ id: z.string() }), response: { 200: SubscriptionView } },
  }, async (req, reply) => {
    const hh = requireHousehold(req);
    const sub = await repo.cancel({ householdId: hh.id, actorUuid: requireUser(req).sub });
    if (!sub) return reply.code(200).send(present("free", "active", null));
    return reply.code(200).send(present(sub.plan, sub.status, sub.currentPeriodEnd));
  });
};
```

Register in `src/http/index.ts`: `await app.register(subscriptionsRoutes);` after `householdsRoutes`.

- [ ] **Step 3: typecheck** — `pnpm typecheck` clean.
- [ ] **Step 4: commit**

```bash
git add src/http/api/subscriptions/index.ts src/http/api/subscriptions/subscriptions.schema.ts src/http/index.ts
git commit -m "feat(subscription): get/activate/cancel routes"
```

---

### Task 5: e2e

**Files:** Create `test/e2e/subscription.e2e.test.ts`.

- [ ] **Step 1: test**

```ts
// test/e2e/subscription.e2e.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "./helpers/app.js";
describe("subscription e2e (db)", () => {
  let h: TestApp;
  async function login(t: string) { return (await h.app.inject({ method: "POST", url: "/auth/google", payload: { idToken: t } })).json().accessToken as string; }
  beforeAll(async () => { h = await buildTestApp(); }, 120_000);
  afterAll(async () => { await h.close(); });
  it("defaults to free, activates premium, cancels back to free", async () => {
    const auth = { authorization: `Bearer ${await login("alice")}` };
    const hh = await h.app.inject({ method: "POST", url: "/households", headers: auth, payload: { name: "Casa", type: "individual" } });
    const id = hh.json().id as string;
    const s = { ...auth, "x-household-id": id };
    const def = await h.app.inject({ method: "GET", url: `/households/${id}/subscription`, headers: s });
    expect(def.json()).toMatchObject({ plan: "free", entitlements: { aiInsights: false } });
    const act = await h.app.inject({ method: "POST", url: `/households/${id}/subscription/activate`, headers: s });
    expect(act.json()).toMatchObject({ plan: "premium", status: "active", entitlements: { aiInsights: true } });
    const get2 = await h.app.inject({ method: "GET", url: `/households/${id}/subscription`, headers: s });
    expect(get2.json().plan).toBe("premium");
    const can = await h.app.inject({ method: "POST", url: `/households/${id}/subscription/cancel`, headers: s });
    expect(can.json()).toMatchObject({ status: "canceled", entitlements: { aiInsights: false } });
  });
});
```

- [ ] **Step 2: run** — `pnpm test:e2e -- subscription` PASS; `pnpm test:run` full green.
- [ ] **Step 3: commit**

```bash
git add test/e2e/subscription.e2e.test.ts
git commit -m "test(e2e): subscription default/activate/cancel"
```

---

### Task 6: export OpenAPI

- [ ] `pnpm test:run` green + `pnpm typecheck` clean.
- [ ] `npx tsx scripts/export-openapi.ts ../finance-app/api.json`; verify `grep -o '"operationId": *"[a-zA-Z]*"' ../finance-app/api.json | grep -iE 'Subscription'` → getSubscription, activateSubscription, cancelSubscription.
- [ ] `cd ../finance-app && git add api.json && git commit -m "chore(api): regenerate OpenAPI with subscription endpoints"`.

---

## Self-Review

**Spec coverage:** subscription table (Task 1); entitlements config (Task 2); repository (Task 3); GET/activate/cancel (Task 4); e2e (Task 5); OpenAPI (Task 6). Frontend-first gating: backend just exposes entitlements — no existing-feature enforcement (non-breaking). ✓
**Placeholder scan:** none.
**Type consistency:** `SubscriptionPlan`/`SubscriptionStatus` (table) flow through entitlements, repo, routes; `Subscription` domain type used by repo + routes; presenter builds `SubscriptionView` with `entitlementsFor`.
**Confirmed against source:** entityColumns/requireHouseholdRole/requireHousehold/requireUser patterns match existing modules; partial unique index uses `.where(sql\`… is null\`)`.
