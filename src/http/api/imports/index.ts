import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { db } from "../../../infra/db/client.js";
import { ERRORS } from "../../../shared/errors/catalog.js";
import { requireUser } from "../../hooks/auth/auth.js";
import { requireHousehold, requireHouseholdRole } from "../../hooks/household/household.js";
import { createAccountsRepository } from "../accounts/accounts.repository.js";
import { createCategoriesRepository } from "../categories/categories.repository.js";
import { createTransactionsRepository } from "../transactions/transactions.repository.js";
import { createImportService } from "./import.service.js";
import { createImportsRepository } from "./imports.repository.js";
import { CreateImportBody, ImportResultView } from "./imports.schema.js";

// Importing a statement/receipt is an `adult`-level action. The Deepseek gateway is
// pulled from the request (so tests inject a fake); categorization is best-effort.
export const importsRoutes: FastifyPluginAsync = async (app) => {
  const accountsRepo = createAccountsRepository(db);
  const categoriesRepo = createCategoriesRepository(db);
  const transactionsRepo = createTransactionsRepository(db);
  const importsRepo = createImportsRepository(db);

  app.withTypeProvider<ZodTypeProvider>().post(
    "/imports",
    {
      preHandler: requireHouseholdRole("adult"),
      schema: {
        operationId: "createImport",
        tags: ["imports"],
        summary: "Import transactions from an OFX/CSV statement or receipt text",
        body: CreateImportBody,
        response: { 201: ImportResultView },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      const account = await accountsRepo.findByUuid(hh.id, req.body.accountId);
      if (!account) throw ERRORS.RESOURCE.NOT_FOUND();

      const service = createImportService({
        deepseek: req.server.gateways.deepseek,
        categoriesRepo,
        transactionsRepo,
        importsRepo,
      });
      const result = await service({
        householdId: hh.id,
        accountId: account.id,
        source: req.body.source,
        content: req.body.content,
        actorUuid: requireUser(req).sub,
      });
      return reply.code(201).send(result);
    },
  );
};
