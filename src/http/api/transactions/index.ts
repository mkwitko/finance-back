import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { db } from "../../../infra/db/client.js";
import { ERRORS } from "../../../shared/errors/catalog.js";
import { requireUser } from "../../hooks/auth/auth.js";
import { requireHousehold, requireHouseholdRole } from "../../hooks/household/household.js";
import { createAccountsRepository } from "../accounts/accounts.repository.js";
import { createCategoriesRepository } from "../categories/categories.repository.js";
import type { TransactionListItem } from "./transactions.repository.js";
import { createTransactionsRepository } from "./transactions.repository.js";
import {
  CreateTransactionBody,
  CreateTransactionResponse,
  ListTransactionsQuery,
  ListTransactionsResponse,
  type TransactionView,
} from "./transactions.schema.js";

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

export const transactionsRoutes: FastifyPluginAsync = async (app) => {
  const repo = createTransactionsRepository(db);
  const accountsRepo = createAccountsRepository(db);
  const categoriesRepo = createCategoriesRepository(db);

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

  app.withTypeProvider<ZodTypeProvider>().post(
    "/transactions",
    {
      // `child` and up can log spending; `viewer` cannot (read-only role).
      preHandler: requireHouseholdRole("child"),
      schema: {
        operationId: "createTransaction",
        tags: ["transactions"],
        summary: "Add a transaction manually",
        body: CreateTransactionBody,
        response: { 201: CreateTransactionResponse },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      const acc = await accountsRepo.findByUuid(hh.uuid, req.body.accountId);
      if (!acc) throw ERRORS.RESOURCE.NOT_FOUND();

      let categoryId: string | null = null;
      if (req.body.categoryId) {
        const cat = await categoriesRepo.findVisibleByUuid(hh.uuid, req.body.categoryId);
        if (!cat) throw ERRORS.RESOURCE.NOT_FOUND();
        categoryId = cat.uuid;
      }

      const created = await repo.create({
        accountId: acc.uuid,
        categoryId,
        importBatchId: null,
        amountCents: req.body.amountCents,
        direction: req.body.direction,
        occurredAt: new Date(req.body.occurredAt),
        description: req.body.description,
        source: "manual",
        rawRef: null,
        aiCategorized: false,
        aiConfidence: null,
        actorUuid: requireUser(req).sub,
      });
      return reply.code(201).send({ id: created.uuid });
    },
  );
};
