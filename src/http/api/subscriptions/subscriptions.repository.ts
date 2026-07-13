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
