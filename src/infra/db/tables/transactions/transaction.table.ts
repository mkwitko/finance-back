import { bigint, boolean, index, integer, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";
import { TRANSACTION_DIRECTIONS, TRANSACTION_SOURCES } from "../../../../domain/enums.js";
import { entityColumns } from "../../columns.js";
import { account } from "../accounts/account.table.js";
import { category } from "../categories/category.table.js";
import { importBatch } from "../imports/import-batch.table.js";

// A single money movement. Amount is stored as a POSITIVE integer in cents
// (`amount_cents`); `direction` carries the sign so we never deal with float money.
// `source` records how it entered the system; AI-categorized rows keep the model's
// confidence (0-100) so the UI can flag low-confidence guesses for user review.

export const transaction = pgTable(
  "transaction",
  {
    ...entityColumns("transaction"),
    accountId: bigint("account_id", { mode: "number" })
      .notNull()
      .references(() => account.id, { onDelete: "cascade" }),
    categoryId: bigint("category_id", { mode: "number" }).references(() => category.id, {
      onDelete: "set null",
    }),
    importBatchId: bigint("import_batch_id", { mode: "number" }).references(() => importBatch.id, {
      onDelete: "set null",
    }),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    direction: varchar("direction", { length: 8, enum: TRANSACTION_DIRECTIONS }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    description: varchar("description", { length: 512 }).notNull(),
    source: varchar("source", { length: 16, enum: TRANSACTION_SOURCES }).notNull(),
    // Raw upstream reference (OFX FITID / statement line) for dedup on re-import.
    rawRef: varchar("raw_ref", { length: 512 }),
    aiCategorized: boolean("ai_categorized").notNull().default(false),
    aiConfidence: integer("ai_confidence"),
  },
  (t) => [
    index("idx_transaction_account_date").on(t.accountId, t.occurredAt),
    index("idx_transaction_category").on(t.categoryId),
  ],
);

export type TransactionRow = typeof transaction.$inferSelect;
export type TransactionInsert = typeof transaction.$inferInsert;
