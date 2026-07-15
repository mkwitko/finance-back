import type { FastifyPluginAsync } from "fastify";
import { createAccountRoute } from "./create-account/create-account.controller.js";
import { listAccountsRoute } from "./list-accounts/list-accounts.controller.js";

export const accountsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(createAccountRoute);
  await app.register(listAccountsRoute);
};
