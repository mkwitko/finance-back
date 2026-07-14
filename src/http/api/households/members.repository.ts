import type { MembershipRole } from "../../../domain/enums.js";
import type { Db } from "../../../infra/db/client.js";

export type Member = {
  userId: string; // public uuid
  name: string;
  role: MembershipRole;
  joinedAt: string;
};

export interface MembersRepository {
  listMembers(householdId: string): Promise<Member[]>;
  countOwners(householdId: string): Promise<number>;
  findMember(
    householdId: string,
    userUuid: string,
  ): Promise<{ membershipUuid: string; userId: string; role: MembershipRole } | null>;
  updateRole(args: {
    householdId: string;
    userId: string;
    role: MembershipRole;
    actorUuid: string;
  }): Promise<void>;
  removeMember(args: { householdId: string; userId: string; actorUuid: string }): Promise<void>;
}

export function createMembersRepository(db: Db): MembersRepository {
  return {
    async listMembers(householdId) {
      const rows = await db.membership.findMany({
        where: { householdId, deletedAt: null },
        select: { role: true, createdAt: true, user: { select: { uuid: true, name: true } } },
      });
      return rows.map((r) => ({
        userId: r.user.uuid,
        name: r.user.name,
        role: r.role,
        joinedAt: r.createdAt.toISOString(),
      }));
    },

    async countOwners(householdId) {
      return db.membership.count({ where: { householdId, role: "owner", deletedAt: null } });
    },

    async findMember(householdId, userUuid) {
      const row = await db.membership.findFirst({
        where: { householdId, userId: userUuid, deletedAt: null },
        select: { uuid: true, userId: true, role: true },
      });
      if (!row) return null;
      return { membershipUuid: row.uuid, userId: row.userId, role: row.role };
    },

    async updateRole({ householdId, userId, role, actorUuid }) {
      await db.membership.update({
        where: { userId_householdId: { userId, householdId } },
        data: { role, updatedBy: actorUuid, updatedAt: new Date() },
      });
    },

    async removeMember({ householdId, userId, actorUuid }) {
      await db.membership.update({
        where: { userId_householdId: { userId, householdId } },
        data: { deletedAt: new Date(), updatedBy: actorUuid, updatedAt: new Date() },
      });
    },
  };
}
