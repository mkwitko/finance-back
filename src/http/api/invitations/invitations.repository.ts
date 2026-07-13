import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "../../../infra/db/client.js";
import { household } from "../../../infra/db/tables/households/household.table.js";
import {
  type InvitationRow,
  invitation,
} from "../../../infra/db/tables/households/invitation.table.js";
import type { MembershipRole } from "../../../infra/db/tables/households/membership.table.js";
import { generateInviteCode } from "./code.js";

export type Invitation = {
  id: string;
  code: string;
  role: MembershipRole;
  expiresAt: string;
  createdAt: string;
};

function toDomain(row: InvitationRow): Invitation {
  return {
    id: row.uuid,
    code: row.code,
    role: row.role,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export interface InvitationsRepository {
  create(args: {
    householdId: number;
    role: MembershipRole;
    expiresAt: Date;
    actorUuid: string;
  }): Promise<Invitation>;
  listActive(householdId: number): Promise<Invitation[]>;
  findActiveByCode(
    code: string,
  ): Promise<(Invitation & { householdDbId: number; householdUuid: string }) | null>;
  revoke(args: {
    householdId: number;
    invitationUuid: string;
    actorUuid: string;
  }): Promise<boolean>;
}

export function createInvitationsRepository(db: Db): InvitationsRepository {
  return {
    async create({ householdId, role, expiresAt, actorUuid }) {
      const now = new Date();
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const inserted = await db
            .insert(invitation)
            .values({
              householdId,
              code: generateInviteCode(),
              role,
              expiresAt,
              createdBy: actorUuid,
              updatedBy: actorUuid,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          return toDomain(inserted[0] as InvitationRow);
        } catch (err) {
          // Unique-code collision → retry with a fresh code. Anything else rethrows.
          const pgCode = (err as { code?: string })?.code;
          if (pgCode !== "23505") throw err;
          if (attempt === 4) throw err;
        }
      }
      throw new Error("unreachable");
    },

    async listActive(householdId) {
      const rows = await db
        .select()
        .from(invitation)
        .where(
          and(
            eq(invitation.householdId, householdId),
            isNull(invitation.revokedAt),
            isNull(invitation.deletedAt),
            gt(invitation.expiresAt, new Date()),
          ),
        );
      return rows.map(toDomain);
    },

    async findActiveByCode(code) {
      const rows = await db
        .select({ inv: invitation, householdUuid: household.uuid })
        .from(invitation)
        .innerJoin(household, eq(household.id, invitation.householdId))
        .where(
          and(
            eq(invitation.code, code),
            isNull(invitation.revokedAt),
            isNull(invitation.deletedAt),
            gt(invitation.expiresAt, new Date()),
          ),
        )
        .limit(1);
      const r = rows[0];
      if (!r) return null;
      return { ...toDomain(r.inv), householdDbId: r.inv.householdId, householdUuid: r.householdUuid };
    },

    async revoke({ householdId, invitationUuid, actorUuid }) {
      const res = await db
        .update(invitation)
        .set({ revokedAt: new Date(), updatedBy: actorUuid, updatedAt: new Date() })
        .where(and(eq(invitation.householdId, householdId), eq(invitation.uuid, invitationUuid)))
        .returning({ id: invitation.id });
      return res.length > 0;
    },
  };
}
