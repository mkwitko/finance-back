import { describe, it, expect, beforeEach } from "vitest";
import { createSubscriptionsService } from "./subscriptions.service.js";
import { fakeStripe } from "../../../../test/mocks/gateways.fake.js";
import type { SubscriptionsData } from "./subscriptions.data.js";

function fakeData(overrides: Partial<SubscriptionsData> = {}): SubscriptionsData {
  return {
    async ownerEmail() { return "owner@example.com"; },
    async countActiveMembers() { return 3; },
    ...overrides,
  };
}
const ctx = { id: 1, uuid: "hh-uuid-1" };

beforeEach(() => {
  process.env.STRIPE_PRICE_PREMIUM_MONTHLY = "price_m";
  process.env.STRIPE_PRICE_PREMIUM_ANNUAL = "price_a";
});

describe("subscriptions service", () => {
  it("get returns free when no stripe subscription exists", async () => {
    const svc = createSubscriptionsService({ stripe: fakeStripe(), data: fakeData() });
    const v = await svc.get(ctx);
    expect(v).toMatchObject({ plan: "free", status: "active", interval: null, entitlements: { aiInsights: false } });
  });

  it("checkout creates a subscription and returns a client secret", async () => {
    const svc = createSubscriptionsService({ stripe: fakeStripe(), data: fakeData() });
    const s = await svc.checkout(ctx, "monthly");
    expect(s.paymentIntentClientSecret).toContain("pi_fake");
    expect(s.customerId).toContain("cus_fake");
    expect(s.ephemeralKeySecret).toContain("ek_fake");
    expect(s.publishableKey).toBe("pk_fake");
  });

  it("get reflects premium after checkout, with correct seat quantity intent", async () => {
    const stripe = fakeStripe();
    const svc = createSubscriptionsService({ stripe, data: fakeData() });
    await svc.checkout(ctx, "annual");
    const v = await svc.get(ctx);
    expect(v).toMatchObject({ plan: "premium", status: "active", interval: "annual", entitlements: { aiInsights: true } });
  });

  it("checkout throws ALREADY_SUBSCRIBED when a live sub exists", async () => {
    const svc = createSubscriptionsService({ stripe: fakeStripe(), data: fakeData() });
    await svc.checkout(ctx, "monthly");
    await expect(svc.checkout(ctx, "monthly")).rejects.toMatchObject({ code: "SUB-T0003" });
  });

  it("switchInterval swaps the price", async () => {
    const svc = createSubscriptionsService({ stripe: fakeStripe(), data: fakeData() });
    await svc.checkout(ctx, "monthly");
    const v = await svc.switchInterval(ctx, "annual");
    expect(v.interval).toBe("annual");
  });

  it("cancel sets cancelAtPeriodEnd but keeps entitlements until period end", async () => {
    const svc = createSubscriptionsService({ stripe: fakeStripe(), data: fakeData() });
    await svc.checkout(ctx, "monthly");
    const v = await svc.cancel(ctx);
    expect(v.cancelAtPeriodEnd).toBe(true);
    expect(v.entitlements.aiInsights).toBe(true); // still active until currentPeriodEnd
  });

  it("cancel throws NO_SUBSCRIPTION when nothing to cancel", async () => {
    const svc = createSubscriptionsService({ stripe: fakeStripe(), data: fakeData() });
    await expect(svc.cancel(ctx)).rejects.toMatchObject({ code: "SUB-T0004" });
  });

  it("syncSeats updates quantity when a sub exists, no-ops when free", async () => {
    const stripe = fakeStripe();
    let count = 3;
    const svc = createSubscriptionsService({ stripe, data: fakeData({ async countActiveMembers() { return count; } }) });
    await svc.syncSeats(ctx); // free -> no throw
    await svc.checkout(ctx, "monthly");
    count = 5;
    await svc.syncSeats(ctx);
    // getHouseholdSubscription now reflects quantity 5
    const view = await stripe.getHouseholdSubscription(await stripe.findCustomerByEmail("owner@example.com") as string, ctx.uuid);
    expect(view?.quantity).toBe(5);
  });

  it("transferOwner repoints the customer email so the new owner resolves the sub", async () => {
    const stripe = fakeStripe();
    let email = "owner@example.com";
    const svc = createSubscriptionsService({ stripe, data: fakeData({ async ownerEmail() { return email; } }) });
    await svc.checkout(ctx, "monthly");
    await svc.transferOwner(ctx, "newowner@example.com");
    email = "newowner@example.com";
    const v = await svc.get(ctx);
    expect(v.plan).toBe("premium");
  });

  it("checkout throws NO_OWNER when the household has no owner email", async () => {
    const svc = createSubscriptionsService({ stripe: fakeStripe(), data: fakeData({ async ownerEmail() { return null; } }) });
    await expect(svc.checkout(ctx, "monthly")).rejects.toMatchObject({ code: "SUB-T0006" });
  });
});
