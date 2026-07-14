import Stripe from "stripe";
import { logger } from "../../infra/observability/logger.js";
import { ERRORS } from "../../shared/errors/catalog.js";

export type StripeSubscriptionView = {
  id: string;
  itemId: string;
  priceId: string;
  status: string;
  quantity: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

export interface StripeGateway {
  readonly enabled: boolean;
  readonly publishableKey: string;
  ensureCustomer(email: string, name?: string): Promise<string>;
  findCustomerByEmail(email: string): Promise<string | null>;
  updateCustomerEmail(customerId: string, email: string): Promise<void>;
  createEphemeralKey(customerId: string): Promise<string>;
  createSubscription(args: {
    customerId: string;
    priceId: string;
    quantity: number;
    householdId: string;
  }): Promise<{ paymentIntentClientSecret: string | null }>;
  getHouseholdSubscription(customerId: string, householdId: string): Promise<StripeSubscriptionView | null>;
  switchPrice(subId: string, itemId: string, priceId: string): Promise<void>;
  setQuantity(subId: string, itemId: string, quantity: number): Promise<void>;
  cancelAtPeriodEnd(subId: string): Promise<void>;
}

const API_VERSION = "2024-06-20" as Stripe.LatestApiVersion;

// The installed stripe SDK's type definitions (22.3.1) may lag/lead the pinned
// API_VERSION literal, so `current_period_end` is read via a narrow cast rather
// than trusting the (possibly drifted) Stripe.Subscription type.
function toView(sub: Stripe.Subscription): StripeSubscriptionView {
  const item = sub.items.data[0];
  const rawPeriodEnd = (sub as unknown as { current_period_end?: number | null }).current_period_end;
  return {
    id: sub.id,
    itemId: item?.id ?? "",
    priceId: item?.price.id ?? "",
    status: sub.status,
    quantity: item?.quantity ?? 1,
    currentPeriodEnd: rawPeriodEnd ? new Date(rawPeriodEnd * 1000).toISOString() : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
  };
}

export function createStripeGateway(opts: { secretKey: string; publishableKey: string }): StripeGateway {
  const enabled = Boolean(opts.secretKey);
  const client = enabled ? new Stripe(opts.secretKey, { apiVersion: API_VERSION }) : null;

  function requireClient(): Stripe {
    if (!client) throw ERRORS.SUB.STRIPE_DISABLED();
    return client;
  }

  async function wrap<T>(fn: (c: Stripe) => Promise<T>): Promise<T> {
    const c = requireClient();
    try {
      return await fn(c);
    } catch (err) {
      logger.warn({ err }, "stripe request failed");
      throw ERRORS.SUB.STRIPE_ERROR();
    }
  }

  return {
    enabled,
    publishableKey: opts.publishableKey,

    findCustomerByEmail(email) {
      return wrap(async (c) => {
        const res = await c.customers.list({ email, limit: 1 });
        return res.data[0]?.id ?? null;
      });
    },
    ensureCustomer(email, name) {
      return wrap(async (c) => {
        const existing = await c.customers.list({ email, limit: 1 });
        if (existing.data[0]) return existing.data[0].id;
        const created = await c.customers.create({ email, ...(name !== undefined ? { name } : {}) });
        return created.id;
      });
    },
    updateCustomerEmail(customerId, email) {
      return wrap(async (c) => {
        await c.customers.update(customerId, { email });
      });
    },
    createEphemeralKey(customerId) {
      return wrap(async (c) => {
        const key = await c.ephemeralKeys.create({ customer: customerId }, { apiVersion: API_VERSION });
        // `secret` is typed optional in the installed SDK (22.3.1) but Stripe always
        // returns it on a successful create; fall back defensively rather than widen
        // the interface's return type to `string | undefined`.
        return key.secret ?? "";
      });
    },
    createSubscription({ customerId, priceId, quantity, householdId }) {
      return wrap(async (c) => {
        const sub = await c.subscriptions.create({
          customer: customerId,
          items: [{ price: priceId, quantity }],
          payment_behavior: "default_incomplete",
          payment_settings: { save_default_payment_method: "on_subscription" },
          expand: ["latest_invoice.payment_intent"],
          metadata: { householdId },
        });
        const invoice = sub.latest_invoice as Stripe.Invoice | null;
        // `payment_intent` on an expanded invoice is typed as `string | Stripe.PaymentIntent | null`
        // (or absent, depending on SDK/type-version drift) — read it via a narrow cast.
        const pi = (invoice as unknown as { payment_intent?: Stripe.PaymentIntent | string | null } | null)
          ?.payment_intent;
        const clientSecret = pi && typeof pi === "object" ? pi.client_secret : null;
        return { paymentIntentClientSecret: clientSecret ?? null };
      });
    },
    getHouseholdSubscription(customerId, householdId) {
      return wrap(async (c) => {
        const res = await c.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
        const live = res.data.find(
          (s) => s.metadata?.householdId === householdId && s.status !== "canceled" && s.status !== "incomplete_expired",
        );
        return live ? toView(live) : null;
      });
    },
    switchPrice(subId, itemId, priceId) {
      return wrap(async (c) => {
        await c.subscriptions.update(subId, {
          items: [{ id: itemId, price: priceId }],
          proration_behavior: "create_prorations",
        });
      });
    },
    setQuantity(subId, itemId, quantity) {
      return wrap(async (c) => {
        await c.subscriptions.update(subId, {
          items: [{ id: itemId, quantity }],
          proration_behavior: "create_prorations",
        });
      });
    },
    cancelAtPeriodEnd(subId) {
      return wrap(async (c) => {
        await c.subscriptions.update(subId, { cancel_at_period_end: true });
      });
    },
  };
}
