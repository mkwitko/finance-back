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
