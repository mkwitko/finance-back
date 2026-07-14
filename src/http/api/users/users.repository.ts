import type { User as UserRow } from "@prisma/client";
import type { Db } from "../../../infra/db/client.js";
import { SYSTEM_ACTOR_UUID } from "../../../shared/constants/system-actor.js";
import type { UpsertGoogleUserInput, User } from "./users.types.js";

function toDomain(row: UserRow): User {
  return {
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
  findById(uuid: string): Promise<User | null>;
  findByUuid(uuid: string): Promise<User | null>;
  listUsers(args: { limit: number }): Promise<User[]>;
}

export function createUsersRepository(db: Db): UsersRepository {
  return {
    async upsertByGoogle(input) {
      const row = await db.user.upsert({
        where: { googleSub: input.googleSub },
        create: {
          googleSub: input.googleSub,
          email: input.email,
          name: input.name,
          picture: input.picture,
          emailVerified: input.emailVerified,
          createdBy: SYSTEM_ACTOR_UUID,
          updatedBy: SYSTEM_ACTOR_UUID,
        },
        update: {
          email: input.email,
          name: input.name,
          picture: input.picture,
          emailVerified: input.emailVerified,
          updatedBy: SYSTEM_ACTOR_UUID,
        },
      });
      return toDomain(row);
    },

    async findById(uuid) {
      const row = await db.user.findUnique({ where: { uuid } });
      return row ? toDomain(row) : null;
    },

    async findByUuid(uuid) {
      const row = await db.user.findUnique({ where: { uuid } });
      return row ? toDomain(row) : null;
    },

    async listUsers({ limit }) {
      const rows = await db.user.findMany({
        where: { deletedAt: null },
        orderBy: [{ createdAt: "desc" }, { uuid: "desc" }],
        take: limit,
      });
      return rows.map(toDomain);
    },
  };
}
