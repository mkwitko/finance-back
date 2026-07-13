import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod/v4";
import { db } from "../../../infra/db/client.js";
import { entitlementsFor } from "../../../domain/entitlements.js";
import { requireUser } from "../../hooks/auth/auth.js";
import { requireHousehold, requireHouseholdRole } from "../../hooks/household/household.js";
import { createSubscriptionsRepository } from "./subscriptions.repository.js";
import { SubscriptionView } from "./subscriptions.schema.js";

export const subscriptionsRoutes: FastifyPluginAsync = async (app) => {
  const repo = createSubscriptionsRepository(db);
  const present = (plan: "free" | "premium", status: "active" | "canceled" | "expired", periodEnd: string | null) => ({
    plan, status, currentPeriodEnd: periodEnd, entitlements: entitlementsFor(plan, status),
  });

  app.withTypeProvider<ZodTypeProvider>().get("/households/:id/subscription", {
    preHandler: requireHouseholdRole("viewer"),
    schema: { operationId: "getSubscription", tags: ["subscriptions"], summary: "Get subscription + entitlements", params: z.object({ id: z.string() }), response: { 200: SubscriptionView } },
  }, async (req, reply) => {
    const hh = requireHousehold(req);
    const sub = await repo.getForHousehold(hh.id);
    if (!sub) return reply.code(200).send(present("free", "active", null));
    return reply.code(200).send(present(sub.plan, sub.status, sub.currentPeriodEnd));
  });

  app.withTypeProvider<ZodTypeProvider>().post("/households/:id/subscription/activate", {
    preHandler: requireHouseholdRole("owner"),
    schema: { operationId: "activateSubscription", tags: ["subscriptions"], summary: "Activate premium (stub)", params: z.object({ id: z.string() }), response: { 200: SubscriptionView } },
  }, async (req, reply) => {
    const hh = requireHousehold(req);
    const periodEnd = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const sub = await repo.upsertActive({ householdId: hh.id, plan: "premium", currentPeriodEnd: periodEnd, actorUuid: requireUser(req).sub });
    return reply.code(200).send(present(sub.plan, sub.status, sub.currentPeriodEnd));
  });

  app.withTypeProvider<ZodTypeProvider>().post("/households/:id/subscription/cancel", {
    preHandler: requireHouseholdRole("owner"),
    schema: { operationId: "cancelSubscription", tags: ["subscriptions"], summary: "Cancel subscription", params: z.object({ id: z.string() }), response: { 200: SubscriptionView } },
  }, async (req, reply) => {
    const hh = requireHousehold(req);
    const sub = await repo.cancel({ householdId: hh.id, actorUuid: requireUser(req).sub });
    if (!sub) return reply.code(200).send(present("free", "active", null));
    return reply.code(200).send(present(sub.plan, sub.status, sub.currentPeriodEnd));
  });
};
