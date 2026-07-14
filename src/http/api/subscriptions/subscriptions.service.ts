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
  get(ctx: { id: number; uuid: string }): Promise<SubscriptionView>;
  checkout(ctx: { id: number; uuid: string }, interval: BillingInterval): Promise<CheckoutSession>;
  switchInterval(ctx: { id: number; uuid: string }, interval: BillingInterval): Promise<SubscriptionView>;
  cancel(ctx: { id: number; uuid: string }): Promise<SubscriptionView>;
  syncSeats(ctx: { id: number; uuid: string }): Promise<void>;
  transferOwner(ctx: { id: number; uuid: string }, newOwnerEmail: string): Promise<void>;
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

  async function requireOwnerEmail(householdId: number): Promise<string> {
    const email = await data.ownerEmail(householdId);
    if (!email) throw ERRORS.SUB.NO_OWNER();
    return email;
  }

  async function liveSub(ctx: { id: number; uuid: string }) {
    const email = await data.ownerEmail(ctx.id);
    if (!email) return null;
    const customerId = await stripe.findCustomerByEmail(email);
    if (!customerId) return null;
    const sub = await stripe.getHouseholdSubscription(customerId, ctx.uuid);
    return sub ? { sub, customerId } : null;
  }

  function present(sub: NonNullable<Awaited<ReturnType<typeof liveSub>>>["sub"]): SubscriptionView {
    const plan = planForPriceId(sub.priceId);
    const status = statusFromStripe(sub.status, sub.cancelAtPeriodEnd);
    return {
      plan,
      status,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      interval: intervalForPriceId(sub.priceId),
      entitlements: entitlementsFor(plan, status),
    };
  }

  return {
    async get(ctx) {
      const found = await liveSub(ctx);
      return found ? present(found.sub) : FREE;
    },

    async checkout(ctx, interval) {
      const email = await requireOwnerEmail(ctx.id);
      const customerId = await stripe.ensureCustomer(email);
      const existing = await stripe.getHouseholdSubscription(customerId, ctx.uuid);
      if (existing) throw ERRORS.SUB.ALREADY_SUBSCRIBED();
      const quantity = await data.countActiveMembers(ctx.id);
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
      const quantity = await data.countActiveMembers(ctx.id);
      if (quantity !== found.sub.quantity) {
        await stripe.setQuantity(found.sub.id, found.sub.itemId, quantity);
      }
    },

    async transferOwner(ctx, newOwnerEmail) {
      const found = await liveSub(ctx);
      if (!found) return; // free household: no billing link to move
      await stripe.updateCustomerEmail(found.customerId, newOwnerEmail);
    },
  };
}
