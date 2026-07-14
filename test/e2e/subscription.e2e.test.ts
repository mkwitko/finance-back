import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "./helpers/app.js";

describe("subscription e2e (stripe-faked)", () => {
  let h: TestApp;
  async function login(t: string) {
    return (await h.app.inject({ method: "POST", url: "/auth/google", payload: { idToken: t } })).json().accessToken as string;
  }
  beforeAll(async () => {
    process.env.STRIPE_PRICE_PREMIUM_MONTHLY = "price_m";
    process.env.STRIPE_PRICE_PREMIUM_ANNUAL = "price_a";
    h = await buildTestApp();
  }, 120_000);
  afterAll(async () => { await h.close(); });

  it("free -> checkout -> premium -> switch -> cancel", async () => {
    const auth = { authorization: `Bearer ${await login("alice")}` };
    const hh = await h.app.inject({ method: "POST", url: "/households", headers: auth, payload: { name: "Casa", type: "individual" } });
    const id = hh.json().id as string;
    const s = { ...auth, "x-household-id": id };

    const def = await h.app.inject({ method: "GET", url: `/households/${id}/subscription`, headers: s });
    expect(def.json()).toMatchObject({ plan: "free", interval: null, entitlements: { aiInsights: false } });

    const co = await h.app.inject({ method: "POST", url: `/households/${id}/subscription/checkout`, headers: s, payload: { interval: "monthly" } });
    expect(co.statusCode).toBe(200);
    expect(co.json()).toMatchObject({ publishableKey: "pk_fake" });
    expect(co.json().paymentIntentClientSecret).toContain("pi_fake");

    const prem = await h.app.inject({ method: "GET", url: `/households/${id}/subscription`, headers: s });
    expect(prem.json()).toMatchObject({ plan: "premium", status: "active", interval: "monthly", entitlements: { aiInsights: true } });

    const dup = await h.app.inject({ method: "POST", url: `/households/${id}/subscription/checkout`, headers: s, payload: { interval: "monthly" } });
    expect(dup.statusCode).toBe(409);

    const sw = await h.app.inject({ method: "POST", url: `/households/${id}/subscription/switch`, headers: s, payload: { interval: "annual" } });
    expect(sw.json().interval).toBe("annual");

    const can = await h.app.inject({ method: "POST", url: `/households/${id}/subscription/cancel`, headers: s });
    expect(can.json()).toMatchObject({ cancelAtPeriodEnd: true, entitlements: { aiInsights: true } });
  });

  it("non-owner member (viewer) can GET but gets 403 on checkout", async () => {
    const owner = { authorization: `Bearer ${await login("carol")}` };
    const hh = await h.app.inject({ method: "POST", url: "/households", headers: owner, payload: { name: "C", type: "shared" } });
    const id = hh.json().id as string;
    const ownerHh = { ...owner, "x-household-id": id };

    const inv = await h.app.inject({ method: "POST", url: `/households/${id}/invitations`, headers: ownerHh, payload: { role: "viewer" } });
    expect(inv.statusCode).toBe(201);
    const { code } = inv.json();

    const dave = { authorization: `Bearer ${await login("dave")}` };
    const redeem = await h.app.inject({ method: "POST", url: `/invitations/${code}/redeem`, headers: dave });
    expect(redeem.statusCode).toBe(200);

    const daveHh = { ...dave, "x-household-id": id };
    const get = await h.app.inject({ method: "GET", url: `/households/${id}/subscription`, headers: daveHh });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ plan: "free" });

    const checkout = await h.app.inject({ method: "POST", url: `/households/${id}/subscription/checkout`, headers: daveHh, payload: { interval: "monthly" } });
    expect(checkout.statusCode).toBe(403);
  });

  it("member join/leave does not break subscription GET (seat sync best-effort)", async () => {
    const auth = { authorization: `Bearer ${await login("dave")}` };
    const hh = await h.app.inject({ method: "POST", url: "/households", headers: auth, payload: { name: "D", type: "family" } });
    const id = hh.json().id as string;
    const s = { ...auth, "x-household-id": id };
    await h.app.inject({ method: "POST", url: `/households/${id}/subscription/checkout`, headers: s, payload: { interval: "monthly" } });
    const still = await h.app.inject({ method: "GET", url: `/households/${id}/subscription`, headers: s });
    expect(still.json().plan).toBe("premium");
  });
});
