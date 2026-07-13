import { bigint, char, index, pgTable, varchar } from "drizzle-orm/pg-core";
import { entityColumns } from "../../columns.js";
import { household } from "../households/household.table.js";

// A money source inside a household. No bank credentials are ever stored — accounts
// are created manually or inferred from imports (OFX/CSV/receipt). `institution` is a
// free-text bank/wallet label ("Nubank", "Carteira"), not a connection.
export const ACCOUNT_KINDS = ["cash", "checking", "credit", "investment", "prepaid"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const account = pgTable(
  "account",
  {
    ...entityColumns("account"),
    householdId: bigint("household_id", { mode: "number" })
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    kind: varchar("kind", { length: 16, enum: ACCOUNT_KINDS }).notNull(),
    institution: varchar("institution", { length: 255 }),
    currency: char("currency", { length: 3 }).notNull().default("BRL"),
  },
  (t) => [index("idx_account_household").on(t.householdId)],
);

export type AccountRow = typeof account.$inferSelect;
export type AccountInsert = typeof account.$inferInsert;
