import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod/v4";
import { db } from "../../../../infra/db/client.js";
import { requireUser } from "../../../hooks/auth/auth.js";
import { requireHousehold, requireHouseholdRole } from "../../../hooks/household/household.js";
import { createInsightsRepository } from "../insights.repository.js";
import { ListInsightsResponse } from "../insights.schema.js";
import { createInsightsService } from "../insights.service.js";

export const refreshInsightsRoute: FastifyPluginAsync = async (app) => {
  const repo = createInsightsRepository(db);

  app.withTypeProvider<ZodTypeProvider>().post(
    "/households/:id/insights/refresh",
    {
      preHandler: requireHouseholdRole("adult"),
      schema: {
        operationId: "refreshInsights",
        tags: ["insights"],
        summary: "Force-regenerate the household's AI insights",
        params: z.object({ id: z.string() }),
        response: { 200: ListInsightsResponse },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      const service = createInsightsService({ repo, gateway: req.server.gateways.deepseek });
      const insights = await service.regenerate({ householdId: hh.uuid, actorUuid: requireUser(req).sub, now: new Date() });
      return reply.code(200).send({ insights });
    },
  );
};
