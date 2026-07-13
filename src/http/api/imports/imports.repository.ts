import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../../../infra/db/client.js";
import type {
  ImportBatchRow,
  ImportSource,
} from "../../../infra/db/tables/imports/import-batch.table.js";
import { importBatch } from "../../../infra/db/tables/imports/import-batch.table.js";
import { transaction } from "../../../infra/db/tables/transactions/transaction.table.js";

export type ImportBatchInfo = { id: number; uuid: string };

export interface ImportsRepository {
  createBatch(input: {
    householdId: number;
    source: ImportSource;
    actorUuid: string;
  }): Promise<ImportBatchInfo>;
  markCompleted(id: number, transactionCount: number): Promise<void>;
  markFailed(id: number, error: string): Promise<void>;
  /** Existing raw references for an account, to skip re-importing the same lines. */
  existingRawRefs(accountId: number, refs: string[]): Promise<Set<string>>;
}

export function createImportsRepository(db: Db): ImportsRepository {
  return {
    async createBatch({ householdId, source, actorUuid }) {
      const now = new Date();
      const inserted = await db
        .insert(importBatch)
        .values({
          householdId,
          source,
          status: "processing",
          createdBy: actorUuid,
          updatedBy: actorUuid,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: importBatch.id, uuid: importBatch.uuid });
      return inserted[0] as ImportBatchRow & ImportBatchInfo;
    },

    async markCompleted(id, transactionCount) {
      await db
        .update(importBatch)
        .set({ status: "completed", transactionCount, updatedAt: new Date() })
        .where(eq(importBatch.id, id));
    },

    async markFailed(id, error) {
      await db
        .update(importBatch)
        .set({ status: "failed", error: error.slice(0, 1024), updatedAt: new Date() })
        .where(eq(importBatch.id, id));
    },

    async existingRawRefs(accountId, refs) {
      if (refs.length === 0) return new Set();
      const rows = await db
        .select({ rawRef: transaction.rawRef })
        .from(transaction)
        .where(
          and(
            eq(transaction.accountId, accountId),
            isNotNull(transaction.rawRef),
            inArray(transaction.rawRef, refs),
          ),
        );
      return new Set(rows.map((r) => r.rawRef as string));
    },
  };
}
