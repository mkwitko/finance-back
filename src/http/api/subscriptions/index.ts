import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod/v4";
import { db } from "../../../infra/db/client.js";
import { requireHousehold, requireHouseholdRole } from "../../hooks/household/household.js";
import { createSubscriptionsData } from "./subscriptions.data.js";
import { createSubscriptionsService } from "./subscriptions.service.js";
import { CheckoutBody, CheckoutSessionView, SubscriptionView } from "./subscriptions.schema.js";

export const subscriptionsRoutes: FastifyPluginAsync = async (app) => {
  const data = createSubscriptionsData(db);
  const svc = () => createSubscriptionsService({ stripe: app.gateways.stripe, data });
  const params = z.object({ id: z.string() });

  app.withTypeProvider<ZodTypeProvider>().get("/households/:id/subscription", {
    preHandler: requireHouseholdRole("viewer"),
    schema: { operationId: "getSubscription", tags: ["subscriptions"], summary: "Get subscription + entitlements", params, response: { 200: SubscriptionView } },
  }, async (req, reply) => {
    const hh = requireHousehold(req);
    return reply.code(200).send(await svc().get({ id: hh.id, uuid: hh.uuid }));
  });

  app.withTypeProvider<ZodTypeProvider>().post("/households/:id/subscription/checkout", {
    preHandler: requireHouseholdRole("owner"),
    schema: { operationId: "checkoutSubscription", tags: ["subscriptions"], summary: "Start a subscription (PaymentSheet)", params, body: CheckoutBody, response: { 200: CheckoutSessionView } },
  }, async (req, reply) => {
    const hh = requireHousehold(req);
    return reply.code(200).send(await svc().checkout({ id: hh.id, uuid: hh.uuid }, req.body.interval));
  });

  app.withTypeProvider<ZodTypeProvider>().post("/households/:id/subscription/switch", {
    preHandler: requireHouseholdRole("owner"),
    schema: { operationId: "switchSubscriptionInterval", tags: ["subscriptions"], summary: "Switch monthly/annual", params, body: CheckoutBody, response: { 200: SubscriptionView } },
  }, async (req, reply) => {
    const hh = requireHousehold(req);
    return reply.code(200).send(await svc().switchInterval({ id: hh.id, uuid: hh.uuid }, req.body.interval));
  });

  app.withTypeProvider<ZodTypeProvider>().post("/households/:id/subscription/cancel", {
    preHandler: requireHouseholdRole("owner"),
    schema: { operationId: "cancelSubscription", tags: ["subscriptions"], summary: "Cancel at period end", params, response: { 200: SubscriptionView } },
  }, async (req, reply) => {
    const hh = requireHousehold(req);
    return reply.code(200).send(await svc().cancel({ id: hh.id, uuid: hh.uuid }));
  });
};
