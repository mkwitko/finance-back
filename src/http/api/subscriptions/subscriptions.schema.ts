import { z } from "zod/v4";
import { SUBSCRIPTION_PLANS, SUBSCRIPTION_STATUSES } from "../../../infra/db/tables/subscriptions/subscription.table.js";

export const EntitlementsView = z.object({
  aiInsights: z.boolean(),
  futureProjection: z.boolean(),
  unlimitedContexts: z.boolean(),
  maxContexts: z.number().int(),
});
export const SubscriptionView = z.object({
  plan: z.enum(SUBSCRIPTION_PLANS),
  status: z.enum(SUBSCRIPTION_STATUSES),
  currentPeriodEnd: z.string().nullable(),
  entitlements: EntitlementsView,
});
