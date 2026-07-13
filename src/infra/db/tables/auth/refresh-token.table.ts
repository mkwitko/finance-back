import { bigint, index, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";
import { entityColumns } from "../../columns.js";
import { user } from "../users/user.table.js";

// Refresh tokens are stored HASHED (sha256 hex) so they can be revoked without
// keeping the secret at rest. Rotation revokes the old row and inserts a new one.
export const refreshToken = pgTable(
  "refresh_token",
  {
    ...entityColumns("refresh_token"),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("idx_refresh_token_user").on(t.userId)],
);

export type RefreshTokenRow = typeof refreshToken.$inferSelect;
export type RefreshTokenInsert = typeof refreshToken.$inferInsert;
