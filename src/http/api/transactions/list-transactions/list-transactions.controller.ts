import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { db } from "../../../../infra/db/client.js";
import { ERRORS } from "../../../../shared/errors/catalog.js";
import { requireHousehold, requireHouseholdRole } from "../../../hooks/household/household.js";
import { createAccountsRepository } from "../../accounts/accounts.repository.js";
import type { TransactionListItem } from "../transactions.repository.js";
import { createTransactionsRepository } from "../transactions.repository.js";
import {
  ListTransactionsQuery,
  ListTransactionsResponse,
  type TransactionView,
} from "../transactions.schema.js";

function present(t: TransactionListItem): TransactionView {
  return {
    id: t.uuid,
    amountCents: t.amountCents,
    direction: t.direction,
    occurredAt: t.occurredAt,
    description: t.description,
    source: t.source,
    aiCategorized: t.aiCategorized,
    aiConfidence: t.aiConfidence,
    category: t.category
      ? { id: t.category.uuid, name: t.category.name, icon: t.category.icon }
      : null,
    account: { id: t.account.uuid, name: t.account.name },
    createdAt: t.createdAt,
  };
}

export const listTransactionsRoute: FastifyPluginAsync = async (app) => {
  const repo = createTransactionsRepository(db);
  const accountsRepo = createAccountsRepository(db);

  app.withTypeProvider<ZodTypeProvider>().get(
    "/transactions",
    {
      preHandler: requireHouseholdRole("viewer"),
      schema: {
        operationId: "listTransactions",
        tags: ["transactions"],
        summary: "List transactions in the active household",
        querystring: ListTransactionsQuery,
        response: { 200: ListTransactionsResponse },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      const filters: { accountId?: string; limit: number } = { limit: req.query.limit };
      if (req.query.accountId) {
        const acc = await accountsRepo.findByUuid(hh.uuid, req.query.accountId);
        if (!acc) throw ERRORS.RESOURCE.NOT_FOUND();
        filters.accountId = acc.uuid;
      }
      const transactions = await repo.listByHousehold(hh.uuid, filters);
      return reply.code(200).send({ transactions: transactions.map(present) });
    },
  );
};
