import type { Category as CategoryRow } from "@prisma/client";
import type { CategoryKind } from "../../../domain/enums.js";
import type { Db } from "../../../infra/db/client.js";

export type Category = {
  uuid: string;
  name: string;
  kind: CategoryKind;
  icon: string | null;
  system: boolean;
  createdAt: string;
};

export type CreateCategoryInput = {
  householdId: string;
  name: string;
  kind: CategoryKind;
  icon: string | null;
  actorUuid: string;
};

function toDomain(row: CategoryRow): Category {
  return {
    uuid: row.uuid,
    name: row.name,
    kind: row.kind,
    icon: row.icon,
    system: row.householdId === null,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface CategoriesRepository {
  /** System defaults (householdId null) + the household's own custom categories. */
  listVisible(householdId: string): Promise<Category[]>;
  create(input: CreateCategoryInput): Promise<Category>;
  /** Resolve a category visible to the household (system OR its own) by uuid. */
  findVisibleByUuid(householdId: string, uuid: string): Promise<Category | null>;
}

export function createCategoriesRepository(db: Db): CategoriesRepository {
  return {
    async listVisible(householdId) {
      const rows = await db.category.findMany({
        where: {
          OR: [{ householdId: null }, { householdId }],
          deletedAt: null,
        },
        orderBy: [{ kind: "asc" }, { name: "asc" }],
      });
      return rows.map(toDomain);
    },

    async create(input) {
      const created = await db.category.create({
        data: {
          householdId: input.householdId,
          name: input.name,
          kind: input.kind,
          icon: input.icon,
          createdBy: input.actorUuid,
          updatedBy: input.actorUuid,
        },
      });
      return toDomain(created);
    },

    async findVisibleByUuid(householdId, uuid) {
      const row = await db.category.findFirst({
        where: {
          uuid,
          OR: [{ householdId: null }, { householdId }],
          deletedAt: null,
        },
      });
      return row ? toDomain(row) : null;
    },
  };
}
