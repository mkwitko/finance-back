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
