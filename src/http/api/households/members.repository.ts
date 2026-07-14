import { and, eq, isNull, sql } from "drizzle-orm";
import type { MembershipRole } from "../../../domain/enums.js";
import type { Db } from "../../../infra/db/client.js";
import { membership } from "../../../infra/db/tables/households/membership.table.js";
import { user } from "../../../infra/db/tables/users/user.table.js";

export type Member = {
  userId: string; // public uuid
  name: string;
  role: MembershipRole;
  joinedAt: string;
};

export interface MembersRepository {
  listMembers(householdId: number): Promise<Member[]>;
  countOwners(householdId: number): Promise<number>;
  findMember(
    householdId: number,
    userUuid: string,
  ): Promise<{ membershipId: number; userId: number; role: MembershipRole } | null>;
  updateRole(args: {
    householdId: number;
    userId: number;
    role: MembershipRole;
    actorUuid: string;
  }): Promise<void>;
  removeMember(args: { householdId: number; userId: number; actorUuid: string }): Promise<void>;
}

export function createMembersRepository(db: Db): MembersRepository {
  return {
    async listMembers(householdId) {
      const rows = await db
        .select({
          userId: user.uuid,
          name: user.name,
          role: membership.role,
          joinedAt: membership.createdAt,
        })
        .from(membership)
        .innerJoin(user, eq(user.id, membership.userId))
        .where(and(eq(membership.householdId, householdId), isNull(membership.deletedAt)));
      return rows.map((r) => ({
        userId: r.userId,
        name: r.name,
        role: r.role,
        joinedAt: r.joinedAt.toISOString(),
      }));
    },

    async countOwners(householdId) {
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(membership)
        .where(
          and(
            eq(membership.householdId, householdId),
            eq(membership.role, "owner"),
            isNull(membership.deletedAt),
          ),
        );
      return rows[0]?.n ?? 0;
    },

    async findMember(householdId, userUuid) {
      const rows = await db
        .select({ membershipId: membership.id, userId: membership.userId, role: membership.role })
        .from(membership)
        .innerJoin(user, eq(user.id, membership.userId))
        .where(
          and(
            eq(membership.householdId, householdId),
            eq(user.uuid, userUuid),
            isNull(membership.deletedAt),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async updateRole({ householdId, userId, role, actorUuid }) {
      await db
        .update(membership)
        .set({ role, updatedBy: actorUuid, updatedAt: new Date() })
        .where(and(eq(membership.householdId, householdId), eq(membership.userId, userId)));
    },

    async removeMember({ householdId, userId, actorUuid }) {
      await db
        .update(membership)
        .set({ deletedAt: new Date(), updatedBy: actorUuid, updatedAt: new Date() })
        .where(and(eq(membership.householdId, householdId), eq(membership.userId, userId)));
    },
  };
}
