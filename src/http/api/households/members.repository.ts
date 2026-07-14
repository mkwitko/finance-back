import type { Prisma } from "@prisma/client";
import type { MembershipRole } from "../../../domain/enums.js";
import type { Db } from "../../../infra/db/client.js";
import { ERRORS } from "../../../shared/errors/catalog.js";

/**
 * Race-safe last-owner guard. Takes a per-household advisory lock (same hashing scheme
 * as insights.repository `replaceAll`) so concurrent leave/demote transactions on the
 * same household serialize; then re-counts owners INSIDE the transaction. Throws
 * LAST_OWNER (HH-T0005) when the pending mutation would leave the household with none.
 */
async function ensureNotLastOwner(tx: Prisma.TransactionClient, householdId: string): Promise<void> {
  await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${householdId}::text, 0))`;
  const owners = await tx.membership.count({ where: { householdId, role: "owner", deletedAt: null } });
  if (owners <= 1) throw ERRORS.HOUSEHOLD.LAST_OWNER();
}

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
    /** When true, enforce the last-owner guard atomically before the mutation. */
    guardLastOwner?: boolean;
  }): Promise<void>;
  removeMember(args: {
    householdId: string;
    userId: string;
    actorUuid: string;
    /** When true, enforce the last-owner guard atomically before the mutation. */
    guardLastOwner?: boolean;
  }): Promise<void>;
  /**
   * Atomic ownership handover: promote an active `adult` member to `owner` and
   * soft-delete the caller's own membership, in a single transaction under the
   * per-household advisory lock. Re-verifies the target is still an active adult
   * inside the lock (throws TRANSFER_TARGET_INELIGIBLE otherwise). No last-owner
   * guard: a new owner is created in the same transaction.
   */
  transferOwnership(args: {
    householdId: string;
    newOwnerUserId: string;
    callerUserId: string;
    actorUuid: string;
  }): Promise<void>;
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

    async updateRole({ householdId, userId, role, actorUuid, guardLastOwner = false }) {
      await db.$transaction(async (tx) => {
        if (guardLastOwner) await ensureNotLastOwner(tx, householdId);
        await tx.membership.update({
          where: { userId_householdId: { userId, householdId } },
          data: { role, updatedBy: actorUuid, updatedAt: new Date() },
        });
      });
    },

    async removeMember({ householdId, userId, actorUuid, guardLastOwner = false }) {
      await db.$transaction(async (tx) => {
        if (guardLastOwner) await ensureNotLastOwner(tx, householdId);
        await tx.membership.update({
          where: { userId_householdId: { userId, householdId } },
          data: { deletedAt: new Date(), updatedBy: actorUuid, updatedAt: new Date() },
        });
      });
    },

    async transferOwnership({ householdId, newOwnerUserId, callerUserId, actorUuid }) {
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${householdId}::text, 0))`;
        // Re-verify the target inside the lock: a concurrent role/membership change
        // could have made it stale between route validation and here.
        const target = await tx.membership.findFirst({
          where: { householdId, userId: newOwnerUserId, role: "adult", deletedAt: null },
          select: { userId: true },
        });
        if (!target) throw ERRORS.HOUSEHOLD.TRANSFER_TARGET_INELIGIBLE();
        const now = new Date();
        await tx.membership.update({
          where: { userId_householdId: { userId: newOwnerUserId, householdId } },
          data: { role: "owner", updatedBy: actorUuid, updatedAt: now },
        });
        // Old owner leaves: no last-owner guard needed, a new owner exists in this tx.
        await tx.membership.update({
          where: { userId_householdId: { userId: callerUserId, householdId } },
          data: { deletedAt: now, updatedBy: actorUuid, updatedAt: now },
        });
      });
    },
  };
}
