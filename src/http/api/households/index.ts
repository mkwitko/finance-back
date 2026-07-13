import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { db } from "../../../infra/db/client.js";
import { ERRORS } from "../../../shared/errors/catalog.js";
import { requireUser } from "../../hooks/auth/auth.js";
import { createUsersRepository } from "../users/users.repository.js";
import { createHouseholdsRepository } from "./households.repository.js";
import {
  CreateHouseholdBody,
  type HouseholdView,
  HouseholdView as HouseholdViewSchema,
  ListHouseholdsResponse,
} from "./households.schema.js";
import type { Household } from "./households.types.js";

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

export const householdsRoutes: FastifyPluginAsync = async (app) => {
  const repo = createHouseholdsRepository(db);
  const usersRepo = createUsersRepository(db);

  app.withTypeProvider<ZodTypeProvider>().post(
    "/households",
    {
      schema: {
        operationId: "createHousehold",
        tags: ["households"],
        summary: "Create a household (caller becomes owner)",
        body: CreateHouseholdBody,
        response: { 201: HouseholdViewSchema },
      },
    },
    async (req, reply) => {
      const auth = requireUser(req);
      const user = await usersRepo.findByUuid(auth.sub);
      if (!user) throw ERRORS.AUTH.USER_NOT_FOUND();
      const created = await repo.create({
        name: req.body.name,
        type: req.body.type,
        ownerUserId: user.id,
        actorUuid: user.uuid,
      });
      return reply.code(201).send(present(created));
    },
  );

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
