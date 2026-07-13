import { sql } from "drizzle-orm";
import { bigint, index, pgTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { entityColumns } from "../../columns.js";
import { household } from "../households/household.table.js";

export const SUBSCRIPTION_PLANS = ["free", "premium"] as const;
export type SubscriptionPlan = (typeof SUBSCRIPTION_PLANS)[number];
export const SUBSCRIPTION_STATUSES = ["active", "canceled", "expired"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

// A household's billing subscription. `provider` defaults to "stub" until a real
// billing integration lands; `providerRef` holds the external subscription id. A
// household has at most one live (non-soft-deleted) subscription, enforced by the
// partial unique index below.
export const subscription = pgTable(
  "subscription",
  {
    ...entityColumns("subscription"),
    householdId: bigint("household_id", { mode: "number" })
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    plan: varchar("plan", { length: 16, enum: SUBSCRIPTION_PLANS }).notNull(),
    status: varchar("status", { length: 16, enum: SUBSCRIPTION_STATUSES }).notNull(),
    provider: varchar("provider", { length: 16 }).notNull().default("stub"),
    providerRef: varchar("provider_ref", { length: 255 }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("uq_subscription_household").on(t.householdId).where(sql`${t.deletedAt} is null`),
    index("idx_subscription_household").on(t.householdId),
  ],
);

export type SubscriptionRow = typeof subscription.$inferSelect;
export type SubscriptionInsert = typeof subscription.$inferInsert;
