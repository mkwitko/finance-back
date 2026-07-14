import type { Db } from "../../../infra/db/client.js";

export type StoredRefreshToken = {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type InsertRefreshTokenInput = {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  actorUuid: string;
};

export type RotateRefreshTokenInput = {
  oldId: string;
  userId: string;
  newHash: string;
  expiresAt: Date;
  actorUuid: string;
};

export interface AuthRepository {
  insertRefreshToken(input: InsertRefreshTokenInput): Promise<void>;
  findByHash(tokenHash: string): Promise<StoredRefreshToken | null>;
  /** Revoke the old token and insert the new one in a single transaction. */
  rotate(input: RotateRefreshTokenInput): Promise<void>;
  /** Idempotent: revoking an unknown/already-revoked token is a no-op. */
  revokeByHash(tokenHash: string): Promise<void>;
}

export function createAuthRepository(db: Db): AuthRepository {
  return {
    async insertRefreshToken(input) {
      await db.refreshToken.create({
        data: {
          userId: input.userId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          createdBy: input.actorUuid,
          updatedBy: input.actorUuid,
        },
      });
    },

    async findByHash(tokenHash) {
      const row = await db.refreshToken.findUnique({
        where: { tokenHash },
        select: { uuid: true, userId: true, expiresAt: true, revokedAt: true },
      });
      if (!row) return null;
      return { id: row.uuid, userId: row.userId, expiresAt: row.expiresAt, revokedAt: row.revokedAt };
    },

    async rotate(input) {
      const now = new Date();
      await db.$transaction(async (tx) => {
        await tx.refreshToken.updateMany({
          where: { uuid: input.oldId, revokedAt: null },
          data: { revokedAt: now, updatedAt: now, updatedBy: input.actorUuid },
        });
        await tx.refreshToken.create({
          data: {
            userId: input.userId,
            tokenHash: input.newHash,
            expiresAt: input.expiresAt,
            createdBy: input.actorUuid,
            updatedBy: input.actorUuid,
          },
        });
      });
    },

    async revokeByHash(tokenHash) {
      const now = new Date();
      await db.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: now, updatedAt: now },
      });
    },
  };
}
