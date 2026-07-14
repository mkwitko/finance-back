import type { FastifyInstance } from "fastify";
import { db } from "../../../infra/db/client.js";
import { logger } from "../../../infra/observability/logger.js";
import { createSubscriptionsData } from "./subscriptions.data.js";
import { createSubscriptionsService } from "./subscriptions.service.js";

/** Best-effort: never throws. Read-time GET stays correct even if this drifts. */
export async function syncSeatsSafe(app: FastifyInstance, ctx: { id: number; uuid: string }): Promise<void> {
  try {
    const svc = createSubscriptionsService({ stripe: app.gateways.stripe, data: createSubscriptionsData(db) });
    await svc.syncSeats(ctx);
  } catch (err) {
    logger.warn({ err, householdId: ctx.uuid }, "seat sync failed (non-blocking)");
  }
}
