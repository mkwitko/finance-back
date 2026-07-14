import type { Account as AccountRow } from "@prisma/client";
import type { AccountKind } from "../../../domain/enums.js";
import type { Db } from "../../../infra/db/client.js";

export type Account = {
  uuid: string;
  name: string;
  kind: AccountKind;
  institution: string | null;
  currency: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateAccountInput = {
  householdId: string;
  name: string;
  kind: AccountKind;
  institution: string | null;
  currency: string;
  actorUuid: string;
};

function toDomain(row: AccountRow): Account {
  return {
    uuid: row.uuid,
    name: row.name,
    kind: row.kind,
    institution: row.institution,
    currency: row.currency,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface AccountsRepository {
  create(input: CreateAccountInput): Promise<Account>;
  listByHousehold(householdId: string): Promise<Account[]>;
  /** Resolve an account by public uuid, scoped to its household (ownership check). */
  findByUuid(householdId: string, uuid: string): Promise<Account | null>;
}

export function createAccountsRepository(db: Db): AccountsRepository {
  return {
    async create(input) {
      const row = await db.account.create({
        data: {
          householdId: input.householdId,
          name: input.name,
          kind: input.kind,
          institution: input.institution,
          currency: input.currency,
          createdBy: input.actorUuid,
          updatedBy: input.actorUuid,
        },
      });
      return toDomain(row);
    },

    async listByHousehold(householdId) {
      const rows = await db.account.findMany({
        where: { householdId, deletedAt: null },
        orderBy: [{ createdAt: "desc" }, { uuid: "desc" }],
      });
      return rows.map(toDomain);
    },

    async findByUuid(householdId, uuid) {
      const row = await db.account.findFirst({
        where: { householdId, uuid, deletedAt: null },
      });
      return row ? toDomain(row) : null;
    },
  };
}
