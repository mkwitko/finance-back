import { entitlementsFor, type Entitlements } from "../../../domain/entitlements.js";
import {
  type BillingInterval,
  intervalForPriceId,
  planForPriceId,
  priceIdForInterval,
  statusFromStripe,
  type SubscriptionPlan,
  type SubscriptionStatus,
} from "../../../domain/subscription.js";
import type { StripeGateway } from "../../../gateways/stripe/stripe.gateway.js";
import { logger } from "../../../infra/observability/logger.js";
import { ERRORS } from "../../../shared/errors/catalog.js";
import type { SubscriptionsData } from "./subscriptions.data.js";

export type SubscriptionView = {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  interval: BillingInterval | null;
  entitlements: Entitlements;
};
export type CheckoutSession = {
  paymentIntentClientSecret: string | null;
  ephemeralKeySecret: string;
  customerId: string;
  publishableKey: string;
};
export type SubscriptionsService = {
  get(ctx: { uuid: string }): Promise<SubscriptionView>;
  checkout(ctx: { uuid: string }, interval: BillingInterval): Promise<CheckoutSession>;
  switchInterval(ctx: { uuid: string }, interval: BillingInterval): Promise<SubscriptionView>;
  cancel(ctx: { uuid: string }): Promise<SubscriptionView>;
  syncSeats(ctx: { uuid: string }): Promise<void>;
  transferOwner(ctx: { uuid: string }, newOwnerEmail: string): Promise<void>;
};

const FREE: SubscriptionView = {
  plan: "free",
  status: "active",
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  interval: null,
  entitlements: entitlementsFor("free", "active"),
};

export function createSubscriptionsService(deps: {
  stripe: StripeGateway;
  data: SubscriptionsData;
}): SubscriptionsService {
  const { stripe, data } = deps;

  async function requireOwnerEmail(householdUuid: string): Promise<string> {
    const email = await data.ownerEmail(householdUuid);
    if (!email) throw ERRORS.SUB.NO_OWNER();
    return email;
  }

  async function liveSub(ctx: { uuid: string }) {
    const email = await data.ownerEmail(ctx.uuid);
    if (!email) return null;
    const customerId = await stripe.findCustomerByEmail(email);
    if (!customerId) return null;
    const sub = await stripe.getHouseholdSubscription(customerId, ctx.uuid);
    return sub ? { sub, customerId } : null;
  }

  function present(sub: NonNullable<Awaited<ReturnType<typeof liveSub>>>["sub"]): SubscriptionView {
    const interval = intervalForPriceId(sub.priceId);
    let plan = planForPriceId(sub.priceId);
    if (interval === null) {
      // A live Stripe subscription whose price ID matches no configured plan — the
      // dashboard price was rotated out from under us. Don't silently downgrade a
      // paying customer to `free`: surface it and fall back to `premium` so their
      // entitlements are preserved until the price config is updated.
      logger.warn(
        { priceId: sub.priceId, status: sub.status },
        "subscription.price_not_in_config — rotated price? falling back to premium",
      );
      plan = "premium";
    }
    const status = statusFromStripe(sub.status);
    return {
      plan,
      status,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      interval,
      entitlements: entitlementsFor(plan, status),
    };
  }

  return {
    async get(ctx) {
      const found = await liveSub(ctx);
      return found ? present(found.sub) : FREE;
    },

    async checkout(ctx, interval) {
      const email = await requireOwnerEmail(ctx.uuid);
      const customerId = await stripe.ensureCustomer(email);
      const existing = await stripe.getHouseholdSubscription(customerId, ctx.uuid);
      if (existing) {
        // `existing.status` is the RAW Stripe status (not the normalized
        // SubscriptionStatus from statusFromStripe): `incomplete` means payment was
        // never confirmed (PaymentSheet abandoned/failed) — that sub hasn't billed
        // anything yet, so we reuse it instead of orphaning a second incomplete
        // subscription and instead of 409-locking the user out for ~23h until Stripe
        // auto-expires it. Any other status (active/trialing/past_due/unpaid/paused/etc)
        // represents a live subscription — reject re-checkout to avoid double-billing.
        if (existing.status === "incomplete") {
          const ephemeralKeySecret = await stripe.createEphemeralKey(customerId);
          const paymentIntentClientSecret = await stripe.getSubscriptionClientSecret(existing.id);
          return { paymentIntentClientSecret, ephemeralKeySecret, customerId, publishableKey: stripe.publishableKey };
        }
        throw ERRORS.SUB.ALREADY_SUBSCRIBED();
      }
      const quantity = await data.countActiveMembers(ctx.uuid);
      const priceId = priceIdForInterval(interval);
      const ephemeralKeySecret = await stripe.createEphemeralKey(customerId);
      const { paymentIntentClientSecret } = await stripe.createSubscription({
        customerId,
        priceId,
        quantity,
        householdId: ctx.uuid,
      });
      return { paymentIntentClientSecret, ephemeralKeySecret, customerId, publishableKey: stripe.publishableKey };
    },

    async switchInterval(ctx, interval) {
      const found = await liveSub(ctx);
      if (!found) throw ERRORS.SUB.NO_SUBSCRIPTION();
      await stripe.switchPrice(found.sub.id, found.sub.itemId, priceIdForInterval(interval));
      const refreshed = await liveSub(ctx);
      return refreshed ? present(refreshed.sub) : FREE;
    },

    async cancel(ctx) {
      const found = await liveSub(ctx);
      if (!found) throw ERRORS.SUB.NO_SUBSCRIPTION();
      await stripe.cancelAtPeriodEnd(found.sub.id);
      const refreshed = await liveSub(ctx);
      return refreshed ? present(refreshed.sub) : FREE;
    },

    async syncSeats(ctx) {
      const found = await liveSub(ctx);
      if (!found) return; // free household: nothing to sync
      const quantity = await data.countActiveMembers(ctx.uuid);
      if (quantity !== found.sub.quantity) {
        await stripe.setQuantity(found.sub.id, found.sub.itemId, quantity);
      }
    },

    async transferOwner(ctx, newOwnerEmail) {
      const found = await liveSub(ctx);
      if (!found) return; // free household: no billing link to move
      // Defensive guard: if the new owner's email already belongs to a DIFFERENT Stripe
      // customer, repointing this subscription's customer to that email would collide
      // (two customers, same email) and could mis-resolve billing later. Fail clearly.
      const collidingCustomerId = await stripe.findCustomerByEmail(newOwnerEmail);
      if (collidingCustomerId && collidingCustomerId !== found.customerId) {
        throw ERRORS.SUB.OWNER_EMAIL_COLLISION();
      }
      await stripe.updateCustomerEmail(found.customerId, newOwnerEmail);
    },
  };
}
