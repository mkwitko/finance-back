import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { db } from "../../../../infra/db/client.js";
import { requireHousehold, requireHouseholdRole } from "../../../hooks/household/household.js";
import { present } from "../categories.present.js";
import { createCategoriesRepository } from "../categories.repository.js";
import { ListCategoriesResponse } from "../categories.schema.js";

export const listCategoriesRoute: FastifyPluginAsync = async (app) => {
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
};
