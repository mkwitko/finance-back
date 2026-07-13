import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../../../infra/db/client.js";
import type { HouseholdRow } from "../../../infra/db/tables/households/household.table.js";
import { household } from "../../../infra/db/tables/households/household.table.js";
import type { MembershipRole } from "../../../infra/db/tables/households/membership.table.js";
import { membership } from "../../../infra/db/tables/households/membership.table.js";
import { user } from "../../../infra/db/tables/users/user.table.js";
import type { CreateHouseholdInput, Household, MembershipContext } from "./households.types.js";

function toDomain(row: HouseholdRow, role?: MembershipRole): Household {
  return {
    id: row.id,
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
    householdId: number;
    userId: number;
    role: MembershipRole;
    actorUuid: string;
  }): Promise<void>;
}

export function createHouseholdsRepository(db: Db): HouseholdsRepository {
  return {
    async create(input) {
      return db.transaction(async (tx) => {
        const now = new Date();
        const inserted = await tx
          .insert(household)
          .values({
            name: input.name,
            type: input.type,
            createdBy: input.actorUuid,
            updatedBy: input.actorUuid,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        const row = inserted[0] as HouseholdRow;
        await tx.insert(membership).values({
          userId: input.ownerUserId,
          householdId: row.id,
          role: "owner",
          createdBy: input.actorUuid,
          updatedBy: input.actorUuid,
          createdAt: now,
          updatedAt: now,
        });
        return toDomain(row, "owner");
      });
    },

    async listForUser(userUuid) {
      const rows = await db
        .select({ h: household, role: membership.role })
        .from(membership)
        .innerJoin(household, eq(household.id, membership.householdId))
        .innerJoin(user, eq(user.id, membership.userId))
        .where(
          and(eq(user.uuid, userUuid), isNull(membership.deletedAt), isNull(household.deletedAt)),
        )
        .orderBy(desc(household.createdAt), desc(household.id));
      return rows.map((r) => toDomain(r.h, r.role));
    },

    async findMembershipContext({ userUuid, householdUuid }) {
      const rows = await db
        .select({
          id: household.id,
          uuid: household.uuid,
          type: household.type,
          role: membership.role,
        })
        .from(membership)
        .innerJoin(household, eq(household.id, membership.householdId))
        .innerJoin(user, eq(user.id, membership.userId))
        .where(
          and(
            eq(user.uuid, userUuid),
            eq(household.uuid, householdUuid),
            isNull(membership.deletedAt),
            isNull(household.deletedAt),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async addMember({ householdId, userId, role, actorUuid }) {
      const now = new Date();
      await db
        .insert(membership)
        .values({
          userId,
          householdId,
          role,
          createdBy: actorUuid,
          updatedBy: actorUuid,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    },
  };
}
