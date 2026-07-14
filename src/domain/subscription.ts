import { ERRORS } from "../shared/errors/catalog.js";

export const SUBSCRIPTION_PLANS = ["free", "premium"] as const;
export type SubscriptionPlan = (typeof SUBSCRIPTION_PLANS)[number];

export const SUBSCRIPTION_STATUSES = ["active", "canceled", "expired"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export type BillingInterval = "monthly" | "annual";

// Price config is read from process.env directly (not the cached env proxy) so it is
// test-overridable and reflects the deployed dashboard prices.
function priceMonthly(): string {
  return process.env.STRIPE_PRICE_PREMIUM_MONTHLY ?? "";
}
function priceAnnual(): string {
  return process.env.STRIPE_PRICE_PREMIUM_ANNUAL ?? "";
}

export function priceIdForInterval(interval: BillingInterval): string {
  const id = interval === "monthly" ? priceMonthly() : priceAnnual();
  if (!id) throw ERRORS.SUB.PRICE_NOT_CONFIGURED({ interval });
  return id;
}

export function intervalForPriceId(priceId: string): BillingInterval | null {
  if (priceId && priceId === priceMonthly()) return "monthly";
  if (priceId && priceId === priceAnnual()) return "annual";
  return null;
}

export function planForPriceId(priceId: string): SubscriptionPlan {
  return intervalForPriceId(priceId) ? "premium" : "free";
}

export function statusFromStripe(stripeStatus: string, _cancelAtPeriodEnd: boolean): SubscriptionStatus {
  if (["active", "trialing", "past_due"].includes(stripeStatus)) return "active";
  if (["canceled", "unpaid", "incomplete_expired"].includes(stripeStatus)) return "canceled";
  return "expired";
}
