import { desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../../../infra/db/client.js";
import type { UserRow } from "../../../infra/db/tables/users/user.table.js";
import { user } from "../../../infra/db/tables/users/user.table.js";
import { SYSTEM_ACTOR_UUID } from "../../../shared/constants/system-actor.js";
import type { UpsertGoogleUserInput, User } from "./users.types.js";

function toDomain(row: UserRow): User {
  return {
    id: row.id,
    uuid: row.uuid,
    email: row.email,
    name: row.name,
    picture: row.picture,
    emailVerified: row.emailVerified,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface UsersRepository {
  /** Upsert by Google `sub` (first-access users are stamped by the SYSTEM actor). */
  upsertByGoogle(input: UpsertGoogleUserInput): Promise<User>;
  findById(id: number): Promise<User | null>;
  findByUuid(uuid: string): Promise<User | null>;
  listUsers(args: { limit: number }): Promise<User[]>;
}

export function createUsersRepository(db: Db): UsersRepository {
  return {
    async upsertByGoogle(input) {
      const existing = await db
        .select()
        .from(user)
        .where(eq(user.googleSub, input.googleSub))
        .limit(1);

      const now = new Date();
      const current = existing[0];
      if (current) {
        const updated = await db
          .update(user)
          .set({
            email: input.email,
            name: input.name,
            picture: input.picture,
            emailVerified: input.emailVerified,
            updatedAt: now,
            updatedBy: SYSTEM_ACTOR_UUID,
          })
          .where(eq(user.id, current.id))
          .returning();
        return toDomain(updated[0] as UserRow);
      }

      const inserted = await db
        .insert(user)
        .values({
          googleSub: input.googleSub,
          email: input.email,
          name: input.name,
          picture: input.picture,
          emailVerified: input.emailVerified,
          createdBy: SYSTEM_ACTOR_UUID,
          updatedBy: SYSTEM_ACTOR_UUID,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return toDomain(inserted[0] as UserRow);
    },

    async findById(id) {
      const rows = await db.select().from(user).where(eq(user.id, id)).limit(1);
      return rows[0] ? toDomain(rows[0]) : null;
    },

    async findByUuid(uuid) {
      const rows = await db.select().from(user).where(eq(user.uuid, uuid)).limit(1);
      return rows[0] ? toDomain(rows[0]) : null;
    },

    async listUsers({ limit }) {
      const rows = await db
        .select()
        .from(user)
        .where(isNull(user.deletedAt))
        .orderBy(desc(user.createdAt), desc(user.id))
        .limit(limit);
      return rows.map(toDomain);
    },
  };
}
