import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../../../infra/db/client.js";
import type { AccountKind, AccountRow } from "../../../infra/db/tables/accounts/account.table.js";
import { account } from "../../../infra/db/tables/accounts/account.table.js";

export type Account = {
  id: number;
  uuid: string;
  name: string;
  kind: AccountKind;
  institution: string | null;
  currency: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateAccountInput = {
  householdId: number;
  name: string;
  kind: AccountKind;
  institution: string | null;
  currency: string;
  actorUuid: string;
};

function toDomain(row: AccountRow): Account {
  return {
    id: row.id,
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
  listByHousehold(householdId: number): Promise<Account[]>;
  /** Resolve an account by public uuid, scoped to its household (ownership check). */
  findByUuid(householdId: number, uuid: string): Promise<Account | null>;
}

export function createAccountsRepository(db: Db): AccountsRepository {
  return {
    async create(input) {
      const now = new Date();
      const inserted = await db
        .insert(account)
        .values({
          householdId: input.householdId,
          name: input.name,
          kind: input.kind,
          institution: input.institution,
          currency: input.currency,
          createdBy: input.actorUuid,
          updatedBy: input.actorUuid,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return toDomain(inserted[0] as AccountRow);
    },

    async listByHousehold(householdId) {
      const rows = await db
        .select()
        .from(account)
        .where(and(eq(account.householdId, householdId), isNull(account.deletedAt)))
        .orderBy(desc(account.createdAt), desc(account.id));
      return rows.map(toDomain);
    },

    async findByUuid(householdId, uuid) {
      const rows = await db
        .select()
        .from(account)
        .where(
          and(
            eq(account.householdId, householdId),
            eq(account.uuid, uuid),
            isNull(account.deletedAt),
          ),
        )
        .limit(1);
      return rows[0] ? toDomain(rows[0]) : null;
    },
  };
}
