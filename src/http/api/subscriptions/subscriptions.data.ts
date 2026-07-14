import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../../../infra/db/client.js";
import { membership } from "../../../infra/db/tables/households/membership.table.js";
import { user } from "../../../infra/db/tables/users/user.table.js";

export type SubscriptionsData = {
  ownerEmail(householdId: number): Promise<string | null>;
  countActiveMembers(householdId: number): Promise<number>;
};

export function createSubscriptionsData(db: Db): SubscriptionsData {
  return {
    async ownerEmail(householdId) {
      const rows = await db
        .select({ email: user.email })
        .from(membership)
        .innerJoin(user, eq(user.id, membership.userId))
        .where(
          and(
            eq(membership.householdId, householdId),
            eq(membership.role, "owner"),
            isNull(membership.deletedAt),
          ),
        )
        .limit(1);
      return rows[0]?.email ?? null;
    },
    async countActiveMembers(householdId) {
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(membership)
        .where(and(eq(membership.householdId, householdId), isNull(membership.deletedAt)));
      return rows[0]?.n ?? 1;
    },
  };
}
