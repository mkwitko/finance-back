import type { Invitation as InvitationRow } from "@prisma/client";
import type { MembershipRole } from "../../../domain/enums.js";
import type { Db } from "../../../infra/db/client.js";
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
    householdId: string;
    role: MembershipRole;
    expiresAt: Date;
    actorUuid: string;
  }): Promise<Invitation>;
  listActive(householdId: string): Promise<Invitation[]>;
  findActiveByCode(code: string): Promise<(Invitation & { householdUuid: string }) | null>;
  revoke(args: {
    householdId: string;
    invitationUuid: string;
    actorUuid: string;
  }): Promise<boolean>;
}

export function createInvitationsRepository(db: Db): InvitationsRepository {
  return {
    async create({ householdId, role, expiresAt, actorUuid }) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const row = await db.invitation.create({
            data: {
              householdId,
              code: generateInviteCode(),
              role,
              expiresAt,
              createdBy: actorUuid,
              updatedBy: actorUuid,
            },
          });
          return toDomain(row);
        } catch (err) {
          // Unique-code collision → retry with a fresh code. Anything else rethrows.
          const pgCode = (err as { code?: string })?.code;
          if (pgCode !== "P2002") throw err;
          if (attempt === 4) throw err;
        }
      }
      throw new Error("unreachable");
    },

    async listActive(householdId) {
      const rows = await db.invitation.findMany({
        where: {
          householdId,
          revokedAt: null,
          deletedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      return rows.map(toDomain);
    },

    async findActiveByCode(code) {
      const row = await db.invitation.findFirst({
        where: {
          code,
          revokedAt: null,
          deletedAt: null,
          expiresAt: { gt: new Date() },
        },
        include: { household: { select: { uuid: true } } },
      });
      if (!row) return null;
      return {
        ...toDomain(row),
        householdUuid: row.household.uuid,
      };
    },

    async revoke({ householdId, invitationUuid, actorUuid }) {
      const res = await db.invitation.updateMany({
        where: { householdId, uuid: invitationUuid },
        data: { revokedAt: new Date(), updatedBy: actorUuid, updatedAt: new Date() },
      });
      return res.count > 0;
    },
  };
}
