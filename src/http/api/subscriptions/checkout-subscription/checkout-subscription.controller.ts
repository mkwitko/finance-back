import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod/v4";
import { db } from "../../../../infra/db/client.js";
import { requireHousehold, requireHouseholdRole } from "../../../hooks/household/household.js";
import { createSubscriptionsData } from "../subscriptions.data.js";
import { createSubscriptionsService } from "../subscriptions.service.js";
import { CheckoutBody, CheckoutSessionView } from "../subscriptions.schema.js";

export const checkoutSubscriptionRoute: FastifyPluginAsync = async (app) => {
  const data = createSubscriptionsData(db);
  // Built once at registration: `app.gateways` is decorated (fastify-plugin) before
  // routes register, and the service is stateless w.r.t. the request.
  const svc = createSubscriptionsService({ stripe: app.gateways.stripe, data });
  const params = z.object({ id: z.string() });

  app.withTypeProvider<ZodTypeProvider>().post("/households/:id/subscription/checkout", {
    preHandler: requireHouseholdRole("owner"),
    schema: { operationId: "checkoutSubscription", tags: ["subscriptions"], summary: "Start a subscription (PaymentSheet)", params, body: CheckoutBody, response: { 200: CheckoutSessionView } },
  }, async (req, reply) => {
    const hh = requireHousehold(req);
    return reply.code(200).send(await svc.checkout({ uuid: hh.uuid }, req.body.interval));
  });
};
