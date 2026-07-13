import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../../infra/db/client.js";
import { refreshToken } from "../../../infra/db/tables/auth/refresh-token.table.js";

export type StoredRefreshToken = {
  id: number;
  userId: number;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type InsertRefreshTokenInput = {
  userId: number;
  tokenHash: string;
  expiresAt: Date;
  actorUuid: string;
};

export type RotateRefreshTokenInput = {
  oldId: number;
  userId: number;
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
      await db.insert(refreshToken).values({
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        createdBy: input.actorUuid,
        updatedBy: input.actorUuid,
      });
    },

    async findByHash(tokenHash) {
      const rows = await db
        .select({
          id: refreshToken.id,
          userId: refreshToken.userId,
          expiresAt: refreshToken.expiresAt,
          revokedAt: refreshToken.revokedAt,
        })
        .from(refreshToken)
        .where(eq(refreshToken.tokenHash, tokenHash))
        .limit(1);
      return rows[0] ?? null;
    },

    async rotate(input) {
      const now = new Date();
      await db.transaction(async (tx) => {
        await tx
          .update(refreshToken)
          .set({ revokedAt: now, updatedAt: now, updatedBy: input.actorUuid })
          .where(and(eq(refreshToken.id, input.oldId), isNull(refreshToken.revokedAt)));
        await tx.insert(refreshToken).values({
          userId: input.userId,
          tokenHash: input.newHash,
          expiresAt: input.expiresAt,
          createdBy: input.actorUuid,
          updatedBy: input.actorUuid,
        });
      });
    },

    async revokeByHash(tokenHash) {
      const now = new Date();
      await db
        .update(refreshToken)
        .set({ revokedAt: now, updatedAt: now })
        .where(and(eq(refreshToken.tokenHash, tokenHash), isNull(refreshToken.revokedAt)));
    },
  };
}
