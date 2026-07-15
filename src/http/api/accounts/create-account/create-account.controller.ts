import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { db } from "../../../../infra/db/client.js";
import { requireUser } from "../../../hooks/auth/auth.js";
import { requireHousehold, requireHouseholdRole } from "../../../hooks/household/household.js";
import { present } from "../accounts.presenter.js";
import { createAccountsRepository } from "../accounts.repository.js";
import { AccountView as AccountViewSchema, CreateAccountBody } from "../accounts.schema.js";

// Household-scoped: requires the `x-household-id` header + membership. Creating an
// account needs `adult` (managing money sources is an adult-level action, not
// something the `child`/`teen` roles do).
export const createAccountRoute: FastifyPluginAsync = async (app) => {
  const repo = createAccountsRepository(db);

  app.withTypeProvider<ZodTypeProvider>().post(
    "/accounts",
    {
      preHandler: requireHouseholdRole("adult"),
      schema: {
        operationId: "createAccount",
        tags: ["accounts"],
        summary: "Create an account in the active household",
        body: CreateAccountBody,
        response: { 201: AccountViewSchema },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      const created = await repo.create({
        householdId: hh.uuid,
        name: req.body.name,
        kind: req.body.kind,
        institution: req.body.institution ?? null,
        currency: req.body.currency,
        actorUuid: requireUser(req).sub,
      });
      return reply.code(201).send(present(created));
    },
  );
};
