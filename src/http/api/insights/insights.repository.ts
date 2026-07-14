import type { Insight as InsightRow } from "@prisma/client";
import type { Db } from "../../../infra/db/client.js";
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
  categorySums(householdId: string, startISO: string, endISO: string): Promise<CategorySum[]>;
  netAllTime(householdId: string): Promise<number>;
  goalsFor(householdId: string): Promise<GoalInput[]>;
  listActive(householdId: string): Promise<Insight[]>;
  latestGeneratedAt(householdId: string): Promise<Date | null>;
  replaceAll(args: {
    householdId: string;
    period: { start: Date; end: Date };
    items: GeneratedInsight[];
    actorUuid: string;
  }): Promise<Insight[]>;
}

export function createInsightsRepository(db: Db): InsightsRepository {
  return {
    async categorySums(householdId, startISO, endISO) {
      const rows = await db.transaction.groupBy({
        by: ["categoryId", "direction"],
        where: {
          deletedAt: null,
          account: { householdId },
          occurredAt: { gte: new Date(startISO), lt: new Date(endISO) },
        },
        _sum: { amountCents: true },
      });
      if (rows.length === 0) return [];

      const categoryIds = [...new Set(rows.map((r) => r.categoryId).filter((id): id is string => id !== null))];
      const categories = categoryIds.length
        ? await db.category.findMany({
            where: { uuid: { in: categoryIds } },
            select: { uuid: true, name: true, kind: true },
          })
        : [];
      const categoryByUuid = new Map(categories.map((c) => [c.uuid, c]));

      // Group by category identity (not just name+kind — two categories can share both),
      // falling back to direction-derived kind for uncategorized transactions.
      const buckets = new Map<string, CategorySum>();
      for (const r of rows) {
        const cat = r.categoryId ? categoryByUuid.get(r.categoryId) : undefined;
        const name = cat?.name ?? "Sem categoria";
        const kind: "income" | "expense" = cat?.kind ?? (r.direction === "in" ? "income" : "expense");
        const key = r.categoryId ?? `null:${kind}`;
        const cents = Number(r._sum.amountCents ?? 0);
        const existing = buckets.get(key);
        if (existing) existing.cents += cents;
        else buckets.set(key, { name, kind, cents });
      }
      return [...buckets.values()];
    },

    async netAllTime(householdId) {
      const rows = await db.transaction.groupBy({
        by: ["direction"],
        where: { deletedAt: null, account: { householdId } },
        _sum: { amountCents: true },
      });
      const inCents = Number(rows.find((r) => r.direction === "in")?._sum.amountCents ?? 0);
      const outCents = Number(rows.find((r) => r.direction === "out")?._sum.amountCents ?? 0);
      return inCents - outCents;
    },

    async goalsFor(householdId) {
      const rows = await db.goal.findMany({
        where: { householdId, deletedAt: null },
        select: { name: true, type: true, targetAmountCents: true, currentAmountCents: true },
      });
      return rows.map((r) => ({
        name: r.name,
        type: r.type,
        targetCents: r.targetAmountCents !== null ? Number(r.targetAmountCents) : null,
        currentCents: Number(r.currentAmountCents),
      }));
    },

    async listActive(householdId) {
      const rows = await db.insight.findMany({
        where: { householdId, deletedAt: null },
        orderBy: [{ generatedAt: "desc" }, { uuid: "desc" }],
      });
      return rows.map(toDomain);
    },

    async latestGeneratedAt(householdId) {
      const row = await db.insight.findFirst({
        where: { householdId, deletedAt: null },
        orderBy: { generatedAt: "desc" },
        select: { generatedAt: true },
      });
      return row?.generatedAt ?? null;
    },

    async replaceAll({ householdId, period, items, actorUuid }) {
      return db.$transaction(async (tx) => {
        // Serialize concurrent regenerations for the same household (uuid hashed to a bigint lock key).
        await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${householdId}::text, 0))`;
        const now = new Date();
        await tx.insight.updateMany({
          where: { householdId, deletedAt: null },
          data: { deletedAt: now, updatedBy: actorUuid, updatedAt: now },
        });
        if (items.length === 0) return [];
        const inserted = await tx.insight.createManyAndReturn({
          data: items.map((it) => ({
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
          })),
        });
        return inserted
          .map(toDomain)
          .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt) || b.id.localeCompare(a.id));
      });
    },
  };
}
