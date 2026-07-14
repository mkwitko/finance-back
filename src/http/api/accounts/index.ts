import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { db } from "../../../infra/db/client.js";
import { requireUser } from "../../hooks/auth/auth.js";
import { requireHousehold, requireHouseholdRole } from "../../hooks/household/household.js";
import { type Account, createAccountsRepository } from "./accounts.repository.js";
import {
  type AccountView,
  AccountView as AccountViewSchema,
  CreateAccountBody,
  ListAccountsResponse,
} from "./accounts.schema.js";

// Household-scoped: every route requires the `x-household-id` header + membership.
// Reads need `viewer`; creating an account needs `adult` (managing money sources is
// an adult-level action, not something the `child`/`teen` roles do).
function present(a: Account): AccountView {
  return {
    id: a.uuid,
    name: a.name,
    kind: a.kind,
    institution: a.institution,
    currency: a.currency,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

export const accountsRoutes: FastifyPluginAsync = async (app) => {
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
