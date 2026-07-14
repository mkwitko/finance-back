import type { TransactionDirection, TransactionSource } from "../../../domain/enums.js";
import type { Db } from "../../../infra/db/client.js";

// Denormalized display row (joins account + category) — what the app's list needs.
export type TransactionListItem = {
  uuid: string;
  amountCents: number;
  direction: TransactionDirection;
  occurredAt: string;
  description: string;
  source: TransactionSource;
  aiCategorized: boolean;
  aiConfidence: number | null;
  category: { uuid: string; name: string; icon: string | null } | null;
  account: { uuid: string; name: string };
  createdAt: string;
};

// Insert shape with internal FK ids already resolved (shared by manual create + import).
export type CreateTransactionInput = {
  accountId: string;
  categoryId: string | null;
  importBatchId: string | null;
  amountCents: number;
  direction: TransactionDirection;
  occurredAt: Date;
  description: string;
  source: TransactionSource;
  rawRef: string | null;
  aiCategorized: boolean;
  aiConfidence: number | null;
  actorUuid: string;
};

export interface TransactionsRepository {
  create(input: CreateTransactionInput): Promise<{ uuid: string }>;
  createMany(inputs: CreateTransactionInput[]): Promise<number>;
  listByHousehold(
    householdId: string,
    filters: { accountId?: string; limit: number },
  ): Promise<TransactionListItem[]>;
}

function toValues(input: CreateTransactionInput, actorUuid: string) {
  return {
    accountId: input.accountId,
    categoryId: input.categoryId,
    importBatchId: input.importBatchId,
    amountCents: input.amountCents,
    direction: input.direction,
    occurredAt: input.occurredAt,
    description: input.description,
    source: input.source,
    rawRef: input.rawRef,
    aiCategorized: input.aiCategorized,
    aiConfidence: input.aiConfidence,
    createdBy: actorUuid,
    updatedBy: actorUuid,
  };
}

export function createTransactionsRepository(db: Db): TransactionsRepository {
  return {
    async create(input) {
      const created = await db.transaction.create({
        data: toValues(input, input.actorUuid),
        select: { uuid: true },
      });
      return { uuid: created.uuid };
    },

    async createMany(inputs) {
      if (inputs.length === 0) return 0;
      const result = await db.transaction.createMany({
        data: inputs.map((i) => toValues(i, i.actorUuid)),
      });
      return result.count;
    },

    async listByHousehold(householdId, filters) {
      const rows = await db.transaction.findMany({
        where: {
          deletedAt: null,
          account: { householdId },
          ...(filters.accountId !== undefined ? { accountId: filters.accountId } : {}),
        },
        select: {
          uuid: true,
          amountCents: true,
          direction: true,
          occurredAt: true,
          description: true,
          source: true,
          aiCategorized: true,
          aiConfidence: true,
          createdAt: true,
          category: { select: { uuid: true, name: true, icon: true } },
          account: { select: { uuid: true, name: true } },
        },
        // Tie-break was (occurredAt, bigint id) desc; id is gone, so tie-break on
        // uuid desc instead. uuid(7) is time-ordered, so uuid-desc among rows
        // sharing the same occurredAt still yields "most recently created first",
        // preserving the old contract's ordering semantics with the new key.
        orderBy: [{ occurredAt: "desc" }, { uuid: "desc" }],
        take: filters.limit,
      });

      return rows.map((r) => ({
        uuid: r.uuid,
        amountCents: Number(r.amountCents),
        direction: r.direction,
        occurredAt: r.occurredAt.toISOString(),
        description: r.description,
        source: r.source,
        aiCategorized: r.aiCategorized,
        aiConfidence: r.aiConfidence,
        category: r.category
          ? { uuid: r.category.uuid, name: r.category.name, icon: r.category.icon }
          : null,
        account: { uuid: r.account.uuid, name: r.account.name },
        createdAt: r.createdAt.toISOString(),
      }));
    },
  };
}
