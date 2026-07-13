import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../../src/infra/db/schema.js";
import { createInsightsRepository } from "../../src/http/api/insights/insights.repository.js";
import { buildTestApp, type TestApp } from "./helpers/app.js";

// Exercises the real SQL in insights.repository against a live Postgres (Testcontainers),
// seeding directly via drizzle so we control internal numeric ids and category identity
// precisely — this is what proves categorySums keeps distinct categories with the same
// name+kind separate (FIX 3) and that the bigint sum casts don't blow up (FIX 2).
describe("insights repository aggregation (db)", () => {
  let h: TestApp;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    h = await buildTestApp();
    db = drizzle(h.pool, { schema });
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  it("sums categories by category id (not just name+kind), computes net all-time, and returns goals", async () => {
    const actor = randomUUID();

    const [household] = await db
      .insert(schema.household)
      .values({ name: "Casa Aggregation", type: "individual", createdBy: actor, updatedBy: actor })
      .returning();
    if (!household) throw new Error("household insert failed");
    const householdId = household.id;

    const [account] = await db
      .insert(schema.account)
      .values({ householdId, name: "Conta", kind: "checking", createdBy: actor, updatedBy: actor })
      .returning();
    if (!account) throw new Error("account insert failed");
    const accountId = account.id;

    // Two DISTINCT categories that share the same name+kind — must NOT be merged.
    const [catA, catB] = await db
      .insert(schema.category)
      .values([
        { householdId, name: "Mercado", kind: "expense", createdBy: actor, updatedBy: actor },
        { householdId, name: "Mercado", kind: "expense", createdBy: actor, updatedBy: actor },
      ])
      .returning();
    if (!catA || !catB) throw new Error("category insert failed");
    expect(catA.id).not.toBe(catB.id);

    const windowStart = new Date("2030-01-01T00:00:00.000Z");
    const windowEnd = new Date("2030-02-01T00:00:00.000Z");
    const inWindow = new Date("2030-01-15T00:00:00.000Z");
    const outOfWindow = new Date("2029-12-01T00:00:00.000Z"); // excluded from categorySums, included in netAllTime

    await db.insert(schema.transaction).values([
      {
        accountId,
        categoryId: catA.id,
        amountCents: 12345,
        direction: "out",
        occurredAt: inWindow,
        description: "Compra A",
        source: "manual",
        createdBy: actor,
        updatedBy: actor,
      },
      {
        accountId,
        categoryId: catB.id,
        amountCents: 6789,
        direction: "out",
        occurredAt: inWindow,
        description: "Compra B",
        source: "manual",
        createdBy: actor,
        updatedBy: actor,
      },
      {
        // No category → collapses into "Sem categoria", kind derived from direction.
        accountId,
        categoryId: null,
        amountCents: 100000,
        direction: "in",
        occurredAt: inWindow,
        description: "Salário",
        source: "manual",
        createdBy: actor,
        updatedBy: actor,
      },
      {
        // Outside the categorySums window, but still counted by netAllTime (no date filter).
        accountId,
        categoryId: catA.id,
        amountCents: 5000,
        direction: "out",
        occurredAt: outOfWindow,
        description: "Compra antiga",
        source: "manual",
        createdBy: actor,
        updatedBy: actor,
      },
    ]);

    await db.insert(schema.goal).values({
      householdId,
      type: "emergency",
      name: "Reserva",
      targetAmountCents: 500000,
      currentAmountCents: 150000,
      createdBy: actor,
      updatedBy: actor,
    });

    const repo = createInsightsRepository(db);

    const sums = await repo.categorySums(householdId, windowStart.toISOString(), windowEnd.toISOString());
    expect(sums).toHaveLength(3);
    for (const s of sums) expect(typeof s.cents).toBe("number");

    // The two same-name-and-kind categories stay separate (FIX 3): two distinct
    // "Mercado"/"expense" buckets, not one merged 19134-cent bucket.
    const mercadoBuckets = sums.filter((s) => s.name === "Mercado" && s.kind === "expense");
    expect(mercadoBuckets).toHaveLength(2);
    expect(mercadoBuckets.map((s) => s.cents).sort((a, b) => a - b)).toEqual([6789, 12345]);

    expect(sums).toContainEqual({ name: "Sem categoria", kind: "income", cents: 100000 });

    // netAllTime includes the out-of-window transaction too: 100000 - 12345 - 6789 - 5000.
    const net = await repo.netAllTime(householdId);
    expect(net).toBe(75866);
    expect(typeof net).toBe("number");

    const goals = await repo.goalsFor(householdId);
    expect(goals).toEqual([{ name: "Reserva", type: "emergency", targetCents: 500000, currentCents: 150000 }]);
  });
});
