import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { Db } from "../../../infra/db/client.js";
import type {
  CategoryKind,
  CategoryRow,
} from "../../../infra/db/tables/categories/category.table.js";
import { category } from "../../../infra/db/tables/categories/category.table.js";

export type Category = {
  id: number;
  uuid: string;
  name: string;
  kind: CategoryKind;
  icon: string | null;
  system: boolean;
  createdAt: string;
};

export type CreateCategoryInput = {
  householdId: number;
  name: string;
  kind: CategoryKind;
  icon: string | null;
  actorUuid: string;
};

function toDomain(row: CategoryRow): Category {
  return {
    id: row.id,
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
  listVisible(householdId: number): Promise<Category[]>;
  create(input: CreateCategoryInput): Promise<Category>;
  /** Resolve a category visible to the household (system OR its own) by uuid. */
  findVisibleByUuid(householdId: number, uuid: string): Promise<Category | null>;
}

export function createCategoriesRepository(db: Db): CategoriesRepository {
  return {
    async listVisible(householdId) {
      const rows = await db
        .select()
        .from(category)
        .where(
          and(
            or(isNull(category.householdId), eq(category.householdId, householdId)),
            isNull(category.deletedAt),
          ),
        )
        .orderBy(asc(category.kind), asc(category.name));
      return rows.map(toDomain);
    },

    async create(input) {
      const now = new Date();
      const inserted = await db
        .insert(category)
        .values({
          householdId: input.householdId,
          name: input.name,
          kind: input.kind,
          icon: input.icon,
          createdBy: input.actorUuid,
          updatedBy: input.actorUuid,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return toDomain(inserted[0] as CategoryRow);
    },

    async findVisibleByUuid(householdId, uuid) {
      const rows = await db
        .select()
        .from(category)
        .where(
          and(
            eq(category.uuid, uuid),
            or(isNull(category.householdId), eq(category.householdId, householdId)),
            isNull(category.deletedAt),
          ),
        )
        .limit(1);
      return rows[0] ? toDomain(rows[0]) : null;
    },
  };
}
