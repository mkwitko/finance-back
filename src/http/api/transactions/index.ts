import type { FastifyPluginAsync } from "fastify";
import { createTransactionRoute } from "./create-transaction/create-transaction.controller.js";
import { listTransactionsRoute } from "./list-transactions/list-transactions.controller.js";

export const transactionsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(listTransactionsRoute);
  await app.register(createTransactionRoute);
};
