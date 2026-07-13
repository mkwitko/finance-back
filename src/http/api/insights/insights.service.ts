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
    if (items.length === 0) return repo.listActive(householdId);
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
