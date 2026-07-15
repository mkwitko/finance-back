import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { db } from "../../../../infra/db/client.js";
import { requireUser } from "../../../hooks/auth/auth.js";
import { createHouseholdsRepository } from "../households.repository.js";
import { type HouseholdView, ListHouseholdsResponse } from "../households.schema.js";
import type { Household } from "../households.types.js";

// These routes manage the caller's OWN households (create / list mine), so they are
// authenticated-only — the `requireHousehold` RBAC hook applies to the resources
// INSIDE a household (accounts, transactions, ...), not to household ownership itself.
function present(h: Household): HouseholdView {
  return {
    id: h.uuid,
    name: h.name,
    type: h.type,
    ...(h.role ? { role: h.role } : {}),
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
  };
}

export const listHouseholdsRoute: FastifyPluginAsync = async (app) => {
  const repo = createHouseholdsRepository(db);

  app.withTypeProvider<ZodTypeProvider>().get(
    "/households",
    {
      schema: {
        operationId: "listHouseholds",
        tags: ["households"],
        summary: "List households the caller belongs to",
        response: { 200: ListHouseholdsResponse },
      },
    },
    async (req, reply) => {
      const auth = requireUser(req);
      const households = await repo.listForUser(auth.sub);
      return reply.code(200).send({ households: households.map(present) });
    },
  );
};
