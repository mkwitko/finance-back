import type { ImportSource } from "../../../domain/enums.js";
import type { Db } from "../../../infra/db/client.js";

export type ImportBatchInfo = { uuid: string };

export interface ImportsRepository {
  createBatch(input: {
    householdId: string;
    source: ImportSource;
    actorUuid: string;
  }): Promise<ImportBatchInfo>;
  markCompleted(uuid: string, transactionCount: number): Promise<void>;
  markFailed(uuid: string, error: string): Promise<void>;
  /** Existing raw references for an account, to skip re-importing the same lines. */
  existingRawRefs(accountId: string, refs: string[]): Promise<Set<string>>;
}

export function createImportsRepository(db: Db): ImportsRepository {
  return {
    async createBatch({ householdId, source, actorUuid }) {
      const row = await db.importBatch.create({
        data: {
          householdId,
          source,
          status: "processing",
          createdBy: actorUuid,
          updatedBy: actorUuid,
        },
      });
      return { uuid: row.uuid };
    },

    async markCompleted(uuid, transactionCount) {
      await db.importBatch.update({
        where: { uuid },
        data: { status: "completed", transactionCount },
      });
    },

    async markFailed(uuid, error) {
      await db.importBatch.update({
        where: { uuid },
        data: { status: "failed", error: error.slice(0, 1024) },
      });
    },

    async existingRawRefs(accountId, refs) {
      if (refs.length === 0) return new Set();
      const rows = await db.transaction.findMany({
        where: { accountId, rawRef: { not: null, in: refs } },
        select: { rawRef: true },
      });
      return new Set(rows.map((r) => r.rawRef as string));
    },
  };
}
