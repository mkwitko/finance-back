import { sql } from "drizzle-orm";
import { bigint, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Standard columns every table carries (spread first in the `pgTable` body).
 *
 * - `id` (`<table>_id`): bigint identity PK — internal, sequential, cheap in FK/index.
 *   NEVER exposed by the API. The JS property is always `id`; only the column name varies.
 * - `uuid`: public identifier — every endpoint lookup uses this.
 * - `created_by` / `updated_by`: audit actor (the `user.uuid` of who wrote the row).
 *   FK to `user.uuid` is added in the baseline migration (DEFERRABLE for `user` itself).
 * - `created_at` / `updated_at`: UTC `timestamptz`.
 * - `deleted_at`: soft-delete.
 */
export function entityColumns(table: string) {
  return {
    id: bigint(`${table}_id`, { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    uuid: uuid("uuid").notNull().unique().defaultRandom(),
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  };
}
