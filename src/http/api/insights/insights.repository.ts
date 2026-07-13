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
