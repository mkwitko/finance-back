import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { db } from "../../../../infra/db/client.js";
import { requireHousehold, requireHouseholdRole } from "../../../hooks/household/household.js";
import { present } from "../accounts.presenter.js";
import { createAccountsRepository } from "../accounts.repository.js";
import { ListAccountsResponse } from "../accounts.schema.js";

// Household-scoped: requires the `x-household-id` header + membership. Reads need
// the `viewer` role.
export const listAccountsRoute: FastifyPluginAsync = async (app) => {
  const repo = createAccountsRepository(db);

  app.withTypeProvider<ZodTypeProvider>().get(
    "/accounts",
    {
      preHandler: requireHouseholdRole("viewer"),
      schema: {
        operationId: "listAccounts",
        tags: ["accounts"],
        summary: "List accounts in the active household",
        response: { 200: ListAccountsResponse },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      const accounts = await repo.listByHousehold(hh.uuid);
      return reply.code(200).send({ accounts: accounts.map(present) });
    },
  );
};
