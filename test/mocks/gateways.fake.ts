import type { DeepseekGateway } from "../../src/gateways/deepseek/deepseek.gateway.js";
import type { GoogleIdentity } from "../../src/gateways/google/google.gateway.js";
import type { StripeGateway, StripeSubscriptionView } from "../../src/gateways/stripe/stripe.gateway.js";
import type { Gateways } from "../../src/types/fastify.js";

// Complete set of fake gateways. `opts.gateways` replaces the whole set at once
// (no partial merge), so buildFakeGateways returns every gateway; override only what
// a test needs. The fake google gateway derives the identity from the idToken value:
// idToken "alice" -> sub "google-alice", email "alice@example.com".
export function buildFakeGateways(overrides: Partial<Gateways> = {}): Gateways {
  return {
    google: {
      verifyIdToken: async (idToken: string): Promise<GoogleIdentity> => ({
        sub: `google-${idToken}`,
        email: `${idToken}@example.com`,
        name: idToken,
        picture: null,
        emailVerified: true,
      }),
    },
    deepseek: fakeDeepseek(),
    stripe: fakeStripe(),
    ...overrides,
  };
}

// Deterministic fake: assigns each item the FIRST category matching its kind
// (income for "in", expense for "out") at 90% confidence. Lets import tests assert
// AI categorization without a network call. extractReceipt returns nothing.
export function fakeDeepseek(): DeepseekGateway {
  return {
    enabled: true,
    async categorizeTransactions(req) {
      return req.items.map((item) => {
        const wantKind = item.direction === "in" ? "income" : "expense";
        const match = req.categories.find((c) => c.kind === wantKind);
        return { index: item.index, category: match?.name ?? null, confidence: 90 };
      });
    },
    async extractReceipt() {
      return [];
    },
    async generateInsights(input) {
      return [
        {
          kind: "summary",
          severity: input.netCurrentCents >= 0 ? "positive" : "warning",
          title: "Resumo do período",
          body: `Saldo do período: ${input.netCurrentCents} centavos.`,
          recommendation: null,
        },
        {
          kind: "advice",
          severity: "info",
          title: "Dica",
          body: "Considere revisar a maior categoria de gasto.",
          recommendation: "Defina um limite mensal para a categoria de maior gasto.",
        },
      ];
    },
  };
}

// In-memory fake Stripe gateway. Keyed by email -> customerId; one live sub per
// (customerId, householdId). Good enough for exercising billing flows without a
// network call.
//
// Mirrors real Stripe's `payment_behavior: "default_incomplete"`: a freshly created
// subscription starts in status "incomplete" and only becomes "active" once the
// client confirms the PaymentIntent (PaymentSheet). Tests simulate that
// confirmation via the extra `confirmSubscription`/`confirmAll` methods below
// (not part of the `StripeGateway` interface — cast to reach them).
export function fakeStripe(): StripeGateway & { confirmSubscription(subId: string): void; confirmAll(): void } {
  const customers = new Map<string, string>(); // email -> customerId
  const subs = new Map<
    string,
    StripeSubscriptionView & { customerId: string; householdId: string; clientSecret: string | null }
  >();
  let seq = 0;
  const custId = (email: string) => {
    const existing = customers.get(email);
    if (existing) return existing;
    const id = `cus_fake_${customers.size + 1}`;
    customers.set(email, id);
    return id;
  };
  const findKey = (customerId: string, householdId: string) =>
    [...subs.values()].find(
      (s) => s.customerId === customerId && s.householdId === householdId && s.status !== "canceled",
    );

  return {
    enabled: true,
    publishableKey: "pk_fake",
    async findCustomerByEmail(email) {
      return customers.get(email) ?? null;
    },
    async ensureCustomer(email) {
      return custId(email);
    },
    async updateCustomerEmail(customerId, email) {
      // repoint: find the email currently mapped to customerId, move it to the new email
      for (const [e, id] of customers) if (id === customerId) customers.delete(e);
      customers.set(email, customerId);
    },
    async createEphemeralKey() {
      return `ek_fake_${++seq}`;
    },
    async createSubscription({ customerId, priceId, quantity, householdId }) {
      const id = `sub_fake_${++seq}`;
      const clientSecret = `pi_fake_${seq}_secret`;
      subs.set(id, {
        id,
        itemId: `si_fake_${seq}`,
        priceId,
        status: "incomplete",
        quantity,
        currentPeriodEnd: "2099-01-01T00:00:00.000Z",
        cancelAtPeriodEnd: false,
        customerId,
        householdId,
        clientSecret,
      });
      return { paymentIntentClientSecret: clientSecret };
    },
    async getHouseholdSubscription(customerId, householdId) {
      const s = findKey(customerId, householdId);
      if (!s) return null;
      const { customerId: _c, householdId: _h, clientSecret: _cs, ...view } = s;
      return view;
    },
    async getSubscriptionClientSecret(subId) {
      return subs.get(subId)?.clientSecret ?? null;
    },
    // TEST-ONLY: simulates the mobile PaymentSheet confirming payment, which is
    // what flips a real Stripe subscription from "incomplete" to "active".
    confirmSubscription(subId: string) {
      const s = subs.get(subId);
      if (s) s.status = "active";
    },
    confirmAll() {
      for (const s of subs.values()) {
        if (s.status !== "canceled") s.status = "active";
      }
    },
    async switchPrice(subId, _itemId, priceId) {
      const s = subs.get(subId);
      if (s) s.priceId = priceId;
    },
    async setQuantity(subId, _itemId, quantity) {
      const s = subs.get(subId);
      if (s) s.quantity = quantity;
    },
    async cancelAtPeriodEnd(subId) {
      const s = subs.get(subId);
      if (s) s.cancelAtPeriodEnd = true;
    },
  };
}
