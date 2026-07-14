import type { Household as HouseholdRow } from "@prisma/client";
import type { MembershipRole } from "../../../domain/enums.js";
import type { Db } from "../../../infra/db/client.js";
import type { CreateHouseholdInput, Household, MembershipContext } from "./households.types.js";

function toDomain(row: HouseholdRow, role?: MembershipRole): Household {
  return {
    uuid: row.uuid,
    name: row.name,
    type: row.type,
    ...(role ? { role } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface HouseholdsRepository {
  /** Create a household and its owner membership atomically. */
  create(input: CreateHouseholdInput): Promise<Household>;
  /** Households the given user belongs to, with the user's role in each. */
  listForUser(userUuid: string): Promise<Household[]>;
  /** Resolve the caller's membership context for one household (RBAC hook). */
  findMembershipContext(args: {
    userUuid: string;
    householdUuid: string;
  }): Promise<MembershipContext | null>;
  /** Add (or ignore-if-exists) a member with a role. */
  addMember(args: {
    householdId: string;
    userId: string;
    role: MembershipRole;
    actorUuid: string;
  }): Promise<void>;
}

export function createHouseholdsRepository(db: Db): HouseholdsRepository {
  return {
    async create(input) {
      return db.$transaction(async (tx) => {
        const row = await tx.household.create({
          data: {
            name: input.name,
            type: input.type,
            createdBy: input.actorUuid,
            updatedBy: input.actorUuid,
          },
        });
        await tx.membership.create({
          data: {
            userId: input.ownerUserUuid,
            householdId: row.uuid,
            role: "owner",
            createdBy: input.actorUuid,
            updatedBy: input.actorUuid,
          },
        });
        return toDomain(row, "owner");
      });
    },

    async listForUser(userUuid) {
      const rows = await db.membership.findMany({
        where: { userId: userUuid, deletedAt: null, household: { deletedAt: null } },
        select: { role: true, household: true },
        orderBy: [{ household: { createdAt: "desc" } }, { household: { uuid: "desc" } }],
      });
      return rows.map((r) => toDomain(r.household, r.role));
    },

    async findMembershipContext({ userUuid, householdUuid }) {
      const row = await db.membership.findFirst({
        where: {
          userId: userUuid,
          householdId: householdUuid,
          deletedAt: null,
          household: { deletedAt: null },
        },
        select: { role: true, household: { select: { uuid: true, type: true } } },
      });
      if (!row) return null;
      return { uuid: row.household.uuid, type: row.household.type, role: row.role };
    },

    async addMember({ householdId, userId, role, actorUuid }) {
      await db.membership.upsert({
        where: { userId_householdId: { userId, householdId } },
        create: {
          userId,
          householdId,
          role,
          createdBy: actorUuid,
          updatedBy: actorUuid,
        },
        // Resurrect a soft-deleted membership on re-join (and adopt the new
        // invite's role). The redeem flow rejects an ACTIVE member before this,
        // so this only ever revives a left/removed membership.
        update: { deletedAt: null, role, updatedBy: actorUuid },
      });
    },
  };
}
