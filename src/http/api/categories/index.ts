import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { db } from "../../../infra/db/client.js";
import { requireUser } from "../../hooks/auth/auth.js";
import { requireHousehold, requireHouseholdRole } from "../../hooks/household/household.js";
import { type Category, createCategoriesRepository } from "./categories.repository.js";
import {
  type CategoryView,
  CategoryView as CategoryViewSchema,
  CreateCategoryBody,
  ListCategoriesResponse,
} from "./categories.schema.js";

function present(c: Category): CategoryView {
  return {
    id: c.uuid,
    name: c.name,
    kind: c.kind,
    icon: c.icon,
    system: c.system,
    createdAt: c.createdAt,
  };
}

export const categoriesRoutes: FastifyPluginAsync = async (app) => {
  const repo = createCategoriesRepository(db);

  app.withTypeProvider<ZodTypeProvider>().get(
    "/categories",
    {
      preHandler: requireHouseholdRole("viewer"),
      schema: {
        operationId: "listCategories",
        tags: ["categories"],
        summary: "List system + household categories",
        response: { 200: ListCategoriesResponse },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      const categories = await repo.listVisible(hh.uuid);
      return reply.code(200).send({ categories: categories.map(present) });
    },
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    "/categories",
    {
      preHandler: requireHouseholdRole("adult"),
      schema: {
        operationId: "createCategory",
        tags: ["categories"],
        summary: "Create a custom category in the active household",
        body: CreateCategoryBody,
        response: { 201: CategoryViewSchema },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      const created = await repo.create({
        householdId: hh.uuid,
        name: req.body.name,
        kind: req.body.kind,
        icon: req.body.icon ?? null,
        actorUuid: requireUser(req).sub,
      });
      return reply.code(201).send(present(created));
    },
  );
};
