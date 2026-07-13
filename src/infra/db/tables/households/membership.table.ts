import { bigint, index, pgTable, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { entityColumns } from "../../columns.js";
import { user } from "../users/user.table.js";
import { household } from "./household.table.js";

// Join between a user and a household, carrying the user's role in that household.
// Roles are ordered by power (see ROLE_RANK in the RBAC hook): owner > adult > teen
// > child > viewer. A user has one membership row per household (unique).
export const MEMBERSHIP_ROLES = ["owner", "adult", "teen", "child", "viewer"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

// Roles ordered by power: owner > adult > teen > child > viewer.
export const ROLE_RANK: Record<MembershipRole, number> = {
  owner: 4,
  adult: 3,
  teen: 2,
  child: 1,
  viewer: 0,
};

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
