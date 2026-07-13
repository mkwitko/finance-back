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
