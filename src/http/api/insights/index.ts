import type { FastifyPluginAsync } from "fastify";
import { getInsightsRoute } from "./get-insights/get-insights.controller.js";
import { refreshInsightsRoute } from "./refresh-insights/refresh-insights.controller.js";

export const insightsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(getInsightsRoute);
  await app.register(refreshInsightsRoute);
};
