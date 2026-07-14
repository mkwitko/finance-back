import type { Db } from "../../../infra/db/client.js";

export type SubscriptionsData = {
  ownerEmail(householdUuid: string): Promise<string | null>;
  memberEmail(householdUuid: string, userUuid: string): Promise<string | null>;
  countActiveMembers(householdUuid: string): Promise<number>;
};

export function createSubscriptionsData(db: Db): SubscriptionsData {
  return {
    async ownerEmail(householdUuid) {
      const row = await db.membership.findFirst({
        where: { householdId: householdUuid, role: "owner", deletedAt: null },
        select: { user: { select: { email: true } } },
      });
      return row?.user.email ?? null;
    },
    async memberEmail(householdUuid, userUuid) {
      const row = await db.membership.findFirst({
        where: { householdId: householdUuid, userId: userUuid, deletedAt: null },
        select: { user: { select: { email: true } } },
      });
      return row?.user.email ?? null;
    },
    async countActiveMembers(householdUuid) {
      return db.membership.count({ where: { householdId: householdUuid, deletedAt: null } });
    },
  };
}
