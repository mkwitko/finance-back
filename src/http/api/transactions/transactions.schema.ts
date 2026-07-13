import { z } from "zod/v4";
import { TRANSACTION_DIRECTIONS } from "../../../infra/db/tables/transactions/transaction.table.js";

export const CreateTransactionBody = z.object({
  accountId: z.uuid(),
  categoryId: z.uuid().nullish(),
  amountCents: z.number().int().positive(),
  direction: z.enum(TRANSACTION_DIRECTIONS),
  occurredAt: z.iso.datetime(),
  description: z.string().min(1).max(512),
});
export type CreateTransactionBody = z.infer<typeof CreateTransactionBody>;

export const ListTransactionsQuery = z.object({
  accountId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListTransactionsQuery = z.infer<typeof ListTransactionsQuery>;

export const TransactionCategoryView = z.object({
  id: z.uuid(),
  name: z.string(),
  icon: z.string().nullable(),
});

export const TransactionView = z.object({
  id: z.uuid(),
  amountCents: z.number().int(),
  direction: z.enum(TRANSACTION_DIRECTIONS),
  occurredAt: z.string(),
  description: z.string(),
  source: z.string(),
  aiCategorized: z.boolean(),
  aiConfidence: z.number().int().nullable(),
  category: TransactionCategoryView.nullable(),
  account: z.object({ id: z.uuid(), name: z.string() }),
  createdAt: z.string(),
});
export type TransactionView = z.infer<typeof TransactionView>;

export const ListTransactionsResponse = z.object({
  transactions: z.array(TransactionView),
});

export const CreateTransactionResponse = z.object({ id: z.uuid() });
