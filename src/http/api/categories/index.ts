import type { FastifyPluginAsync } from "fastify";
import { createCategoryRoute } from "./create-category/create-category.controller.js";
import { listCategoriesRoute } from "./list-categories/list-categories.controller.js";

export const categoriesRoutes: FastifyPluginAsync = async (app) => {
  await app.register(listCategoriesRoute);
  await app.register(createCategoryRoute);
};
