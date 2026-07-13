import { boolean, index, pgTable, varchar } from "drizzle-orm/pg-core";
import { entityColumns } from "../../columns.js";

// Identity owner. `google_sub` is the Google account subject (external system id):
// the stable foreign key from Google Sign-In. We never store a password/hash.
export const user = pgTable(
  "user",
  {
    ...entityColumns("user"),
    googleSub: varchar("google_sub", { length: 255 }).notNull().unique(),
    email: varchar("email", { length: 320 }).notNull().unique(),
    name: varchar("name", { length: 255 }).notNull(),
    picture: varchar("picture", { length: 1024 }),
    emailVerified: boolean("email_verified").notNull().default(false),
  },
  (t) => [index("idx_user_cursor").on(t.createdAt, t.id)],
);

export type UserRow = typeof user.$inferSelect;
export type UserInsert = typeof user.$inferInsert;
