import { z } from "zod/v4";
import { CATEGORY_KINDS } from "../../../domain/enums.js";

export const CreateCategoryBody = z.object({
  name: z.string().min(1).max(128),
  kind: z.enum(CATEGORY_KINDS),
  icon: z.string().max(64).nullish(),
});
export type CreateCategoryBody = z.infer<typeof CreateCategoryBody>;

export const CategoryView = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(CATEGORY_KINDS),
  icon: z.string().nullable(),
  system: z.boolean(),
  createdAt: z.string(),
});
export type CategoryView = z.infer<typeof CategoryView>;

export const ListCategoriesResponse = z.object({
  categories: z.array(CategoryView),
});
