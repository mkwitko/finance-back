import type { FastifyPluginAsync } from "fastify";
import { createHouseholdRoute } from "./create-household/create-household.controller.js";
import { listHouseholdsRoute } from "./list-households/list-households.controller.js";

export const householdsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(createHouseholdRoute);
  await app.register(listHouseholdsRoute);
};
