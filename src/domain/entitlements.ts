import type { SubscriptionPlan, SubscriptionStatus } from "./subscription.js";

export type Entitlements = {
  aiInsights: boolean;
  futureProjection: boolean;
  unlimitedContexts: boolean;
  maxContexts: number;
};

export const PLAN_ENTITLEMENTS: Record<SubscriptionPlan, Entitlements> = {
  free: { aiInsights: false, futureProjection: false, unlimitedContexts: false, maxContexts: 2 },
  premium: { aiInsights: true, futureProjection: true, unlimitedContexts: true, maxContexts: 9999 },
};

export function entitlementsFor(plan: SubscriptionPlan, status: SubscriptionStatus): Entitlements {
  if (status !== "active") return PLAN_ENTITLEMENTS.free;
  return PLAN_ENTITLEMENTS[plan];
}
