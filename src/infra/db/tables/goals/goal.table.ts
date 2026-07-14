import { bigint, index, jsonb, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";
import { GOAL_TYPES } from "../../../../domain/enums.js";
import { entityColumns } from "../../columns.js";
import { household } from "../households/household.table.js";

// A financial objective the copilot tracks and plans toward. Amounts are integer
// cents. `params` holds type-specific inputs (age, monthly contribution, expected
// return, debt list) as JSON so the goal engine can evolve without a migration.

export const goal = pgTable(
  "goal",
  {
    ...entityColumns("goal"),
    householdId: bigint("household_id", { mode: "number" })
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 32, enum: GOAL_TYPES }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    targetAmountCents: bigint("target_amount_cents", { mode: "number" }),
    targetDate: timestamp("target_date", { withTimezone: true }),
    currentAmountCents: bigint("current_amount_cents", { mode: "number" }).notNull().default(0),
    params: jsonb("params").notNull().default({}),
  },
  (t) => [index("idx_goal_household").on(t.householdId)],
);

export type GoalRow = typeof goal.$inferSelect;
export type GoalInsert = typeof goal.$inferInsert;
