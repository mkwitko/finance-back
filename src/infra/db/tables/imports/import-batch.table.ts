import { bigint, index, integer, pgTable, varchar } from "drizzle-orm/pg-core";
import { entityColumns } from "../../columns.js";
import { household } from "../households/household.table.js";

// One ingestion run: an uploaded OFX/CSV statement or a scanned receipt's extracted
// text. Transactions produced by the run link back via `transaction.import_batch_id`.
export const IMPORT_SOURCES = ["ofx", "csv", "receipt"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export const IMPORT_STATUSES = ["pending", "processing", "completed", "failed"] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const importBatch = pgTable(
  "import_batch",
  {
    ...entityColumns("import_batch"),
    householdId: bigint("household_id", { mode: "number" })
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    source: varchar("source", { length: 16, enum: IMPORT_SOURCES }).notNull(),
    status: varchar("status", { length: 16, enum: IMPORT_STATUSES }).notNull().default("pending"),
    // Optional storage pointer to the raw upload (S3 key / path); text stays out of the row.
    fileRef: varchar("file_ref", { length: 1024 }),
    transactionCount: integer("transaction_count").notNull().default(0),
    error: varchar("error", { length: 1024 }),
  },
  (t) => [index("idx_import_batch_household").on(t.householdId)],
);

export type ImportBatchRow = typeof importBatch.$inferSelect;
export type ImportBatchInsert = typeof importBatch.$inferInsert;
