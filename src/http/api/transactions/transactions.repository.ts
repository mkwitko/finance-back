import { and, desc, eq, isNull } from "drizzle-orm";
import type { TransactionDirection, TransactionSource } from "../../../domain/enums.js";
import type { Db } from "../../../infra/db/client.js";
import { account } from "../../../infra/db/tables/accounts/account.table.js";
import { category } from "../../../infra/db/tables/categories/category.table.js";
import { transaction } from "../../../infra/db/tables/transactions/transaction.table.js";

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
  accountId: number;
  categoryId: number | null;
  importBatchId: number | null;
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
    householdId: number,
    filters: { accountId?: number; limit: number },
  ): Promise<TransactionListItem[]>;
}

function toValues(input: CreateTransactionInput, now: Date) {
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
    createdBy: input.actorUuid,
    updatedBy: input.actorUuid,
    createdAt: now,
    updatedAt: now,
  };
}

export function createTransactionsRepository(db: Db): TransactionsRepository {
  return {
    async create(input) {
      const inserted = await db
        .insert(transaction)
        .values(toValues(input, new Date()))
        .returning({ uuid: transaction.uuid });
      return { uuid: inserted[0]?.uuid as string };
    },

    async createMany(inputs) {
      if (inputs.length === 0) return 0;
      const now = new Date();
      const inserted = await db
        .insert(transaction)
        .values(inputs.map((i) => toValues(i, now)))
        .returning({ uuid: transaction.uuid });
      return inserted.length;
    },

    async listByHousehold(householdId, filters) {
      const conditions = [eq(account.householdId, householdId), isNull(transaction.deletedAt)];
      if (filters.accountId !== undefined) {
        conditions.push(eq(transaction.accountId, filters.accountId));
      }
      const rows = await db
        .select({
          uuid: transaction.uuid,
          amountCents: transaction.amountCents,
          direction: transaction.direction,
          occurredAt: transaction.occurredAt,
          description: transaction.description,
          source: transaction.source,
          aiCategorized: transaction.aiCategorized,
          aiConfidence: transaction.aiConfidence,
          categoryUuid: category.uuid,
          categoryName: category.name,
          categoryIcon: category.icon,
          accountUuid: account.uuid,
          accountName: account.name,
          createdAt: transaction.createdAt,
        })
        .from(transaction)
        .innerJoin(account, eq(account.id, transaction.accountId))
        .leftJoin(category, eq(category.id, transaction.categoryId))
        .where(and(...conditions))
        .orderBy(desc(transaction.occurredAt), desc(transaction.id))
        .limit(filters.limit);

      return rows.map((r) => ({
        uuid: r.uuid,
        amountCents: r.amountCents,
        direction: r.direction,
        occurredAt: r.occurredAt.toISOString(),
        description: r.description,
        source: r.source,
        aiCategorized: r.aiCategorized,
        aiConfidence: r.aiConfidence,
        category: r.categoryUuid
          ? { uuid: r.categoryUuid, name: r.categoryName as string, icon: r.categoryIcon }
          : null,
        account: { uuid: r.accountUuid, name: r.accountName },
        createdAt: r.createdAt.toISOString(),
      }));
    },
  };
}
