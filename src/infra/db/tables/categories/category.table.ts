import { type AnyPgColumn, bigint, index, pgTable, varchar } from "drizzle-orm/pg-core";
import { entityColumns } from "../../columns.js";
import { household } from "../households/household.table.js";

// Spending/earning bucket. `householdId = null` marks a SYSTEM default category
// (seeded once, shared by everyone); a non-null value is a household's own custom
// category. `parentId` self-reference allows sub-categories ("Food" > "Delivery").
export const CATEGORY_KINDS = ["income", "expense"] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const category = pgTable(
  "category",
  {
    ...entityColumns("category"),
    // Null => system default category, visible to all households.
    householdId: bigint("household_id", { mode: "number" }).references(() => household.id, {
      onDelete: "cascade",
    }),
    name: varchar("name", { length: 128 }).notNull(),
    kind: varchar("kind", { length: 16, enum: CATEGORY_KINDS }).notNull(),
    parentId: bigint("parent_id", { mode: "number" }).references((): AnyPgColumn => category.id, {
      onDelete: "set null",
    }),
    icon: varchar("icon", { length: 64 }),
  },
  (t) => [index("idx_category_household").on(t.householdId)],
);

export type CategoryRow = typeof category.$inferSelect;
export type CategoryInsert = typeof category.$inferInsert;
