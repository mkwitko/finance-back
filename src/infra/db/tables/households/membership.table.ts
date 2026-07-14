import { bigint, index, pgTable, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { MEMBERSHIP_ROLES } from "../../../../domain/enums.js";
import { entityColumns } from "../../columns.js";
import { user } from "../users/user.table.js";
import { household } from "./household.table.js";

// Join between a user and a household, carrying the user's role in that household.
// Roles are ordered by power (see ROLE_RANK in the RBAC hook): owner > adult > teen
// > child > viewer. A user has one membership row per household (unique).

export const membership = pgTable(
  "membership",
  {
    ...entityColumns("membership"),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    householdId: bigint("household_id", { mode: "number" })
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 16, enum: MEMBERSHIP_ROLES }).notNull(),
  },
  (t) => [
    uniqueIndex("uq_membership_user_household").on(t.userId, t.householdId),
    index("idx_membership_household").on(t.householdId),
  ],
);

export type MembershipRow = typeof membership.$inferSelect;
export type MembershipInsert = typeof membership.$inferInsert;
