import { bigint, index, pgTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { entityColumns } from "../../columns.js";
import { household } from "./household.table.js";
import { MEMBERSHIP_ROLES } from "./membership.table.js";

// A shareable invite code that grants membership (with a fixed `role`) in a household
// when redeemed by a logged-in user. Active = revokedAt IS NULL AND expiresAt > now()
// AND deletedAt IS NULL. Reusable until it expires or is revoked; the membership
// unique index still prevents a user from joining the same household twice.
export const invitation = pgTable(
  "invitation",
  {
    ...entityColumns("invitation"),
    householdId: bigint("household_id", { mode: "number" })
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 12 }).notNull(),
    role: varchar("role", { length: 16, enum: MEMBERSHIP_ROLES }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("uq_invitation_code").on(t.code),
    index("idx_invitation_household").on(t.householdId),
  ],
);

export type InvitationRow = typeof invitation.$inferSelect;
export type InvitationInsert = typeof invitation.$inferInsert;
