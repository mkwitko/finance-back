import { index, pgTable, varchar } from "drizzle-orm/pg-core";
import { HOUSEHOLD_TYPES } from "../../../../domain/enums.js";
import { entityColumns } from "../../columns.js";

// A "money space" shared by one or more users. `type` shapes the UX and the default
// role set: `individual` (solo), `family`, `shared` (e.g. a couple's joint pot), or
// `kids` (allowance space a parent manages). Membership + role live in `membership`.

export const household = pgTable(
  "household",
  {
    ...entityColumns("household"),
    name: varchar("name", { length: 255 }).notNull(),
    type: varchar("type", { length: 32, enum: HOUSEHOLD_TYPES }).notNull(),
  },
  (t) => [index("idx_household_cursor").on(t.createdAt, t.id)],
);

export type HouseholdRow = typeof household.$inferSelect;
export type HouseholdInsert = typeof household.$inferInsert;
