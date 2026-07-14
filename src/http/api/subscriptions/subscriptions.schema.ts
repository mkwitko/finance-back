import { z } from "zod/v4";
import { SUBSCRIPTION_PLANS, SUBSCRIPTION_STATUSES } from "../../../domain/subscription.js";

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
  cancelAtPeriodEnd: z.boolean(),
  interval: z.enum(["monthly", "annual"]).nullable(),
  entitlements: EntitlementsView,
});

export const CheckoutBody = z.object({ interval: z.enum(["monthly", "annual"]) });

export const CheckoutSessionView = z.object({
  paymentIntentClientSecret: z.string().nullable(),
  ephemeralKeySecret: z.string(),
  customerId: z.string(),
  publishableKey: z.string(),
});
