import { bigint, index, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { INSIGHT_KINDS, INSIGHT_SEVERITIES } from "../../../../domain/enums.js";
import { entityColumns } from "../../columns.js";
import { household } from "../households/household.table.js";

// An AI-generated insight card over a household's finances. A "generation" is the
// batch sharing the newest generatedAt; regeneration soft-deletes the prior batch.
export const insight = pgTable(
  "insight",
  {
    ...entityColumns("insight"),
    householdId: bigint("household_id", { mode: "number" })
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 24, enum: INSIGHT_KINDS }).notNull(),
    severity: varchar("severity", { length: 16, enum: INSIGHT_SEVERITIES }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    body: text("body").notNull(),
    recommendation: text("recommendation"),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("idx_insight_household").on(t.householdId)],
);

export type InsightRow = typeof insight.$inferSelect;
export type InsightInsert = typeof insight.$inferInsert;
