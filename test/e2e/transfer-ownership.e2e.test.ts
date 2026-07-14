import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "./helpers/app.js";

// Ownership transfer: owner promotes an adult member to owner and leaves the
// household, repointing the Stripe customer email in the same operation.
describe("transfer-ownership e2e (stripe-faked)", () => {
  let h: TestApp;

  async function login(idToken: string) {
    const res = await h.app.inject({ method: "POST", url: "/auth/google", payload: { idToken } });
    expect(res.statusCode).toBe(200);
    return res.json().accessToken as string;
  }

  // Creates a household owned by `ownerToken` and adds a member with `role` whose
  // login idToken is `memberToken`. Returns the household id + the member's userId.
  async function setupHousehold(opts: {
    ownerToken: string;
    memberToken: string;
    role: "adult" | "teen" | "viewer";
  }): Promise<{ householdId: string; memberUserId: string; ownerHeaders: Record<string, string> }> {
    const owner = { authorization: `Bearer ${await login(opts.ownerToken)}` };
    const hh = await h.app.inject({ method: "POST", url: "/households", headers: owner, payload: { name: "Casa", type: "shared" } });
    const householdId = hh.json().id as string;
    const ownerHeaders = { ...owner, "x-household-id": householdId };

    const inv = await h.app.inject({ method: "POST", url: `/households/${householdId}/invitations`, headers: ownerHeaders, payload: { role: opts.role } });
    expect(inv.statusCode).toBe(201);
    const member = { authorization: `Bearer ${await login(opts.memberToken)}` };
    const redeem = await h.app.inject({ method: "POST", url: `/invitations/${inv.json().code}/redeem`, headers: member });
    expect(redeem.statusCode).toBe(200);

    const members = (await h.app.inject({ method: "GET", url: `/households/${householdId}/members`, headers: ownerHeaders })).json().members as Array<{ userId: string; role: string }>;
    const memberUserId = members.find((m) => m.role === opts.role)!.userId;
    return { householdId, memberUserId, ownerHeaders };
  }

  beforeAll(async () => {
    process.env.STRIPE_PRICE_PREMIUM_MONTHLY = "price_m";
    process.env.STRIPE_PRICE_PREMIUM_ANNUAL = "price_a";
    h = await buildTestApp();
  }, 120_000);
  afterAll(async () => { await h.close(); });

  it("happy path: adult becomes owner, caller leaves, Stripe email repointed", async () => {
    const { householdId, memberUserId, ownerHeaders } = await setupHousehold({ ownerToken: "alice", memberToken: "bob", role: "adult" });

    // Owner starts a paid subscription (creates a Stripe customer for alice@example.com).
    const co = await h.app.inject({ method: "POST", url: `/households/${householdId}/subscription/checkout`, headers: ownerHeaders, payload: { interval: "monthly" } });
    expect(co.statusCode).toBe(200);
    (h.app.gateways.stripe as any).confirmAll();
    const aliceCustomer = await h.app.gateways.stripe.findCustomerByEmail("alice@example.com");
    expect(aliceCustomer).toBeTruthy();

    const res = await h.app.inject({ method: "POST", url: `/households/${householdId}/transfer-ownership`, headers: ownerHeaders, payload: { newOwnerUserId: memberUserId } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    // Stripe customer email repointed to the new owner (same customer id).
    expect(await h.app.gateways.stripe.findCustomerByEmail("alice@example.com")).toBeNull();
    expect(await h.app.gateways.stripe.findCustomerByEmail("bob@example.com")).toBe(aliceCustomer);

    // DB: caller (alice) left → cannot list members; bob is the sole owner.
    const bob = { authorization: `Bearer ${await login("bob")}`, "x-household-id": householdId };
    const members = (await h.app.inject({ method: "GET", url: `/households/${householdId}/members`, headers: bob })).json().members as Array<{ userId: string; role: string }>;
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ userId: memberUserId, role: "owner" });

    const aliceStranded = await h.app.inject({ method: "GET", url: `/households/${householdId}/members`, headers: ownerHeaders });
    expect(aliceStranded.statusCode).toBe(403); // no longer a member
  });

  it("free household: transfer succeeds without any Stripe customer", async () => {
    const { householdId, memberUserId, ownerHeaders } = await setupHousehold({ ownerToken: "carol", memberToken: "dave", role: "adult" });

    const res = await h.app.inject({ method: "POST", url: `/households/${householdId}/transfer-ownership`, headers: ownerHeaders, payload: { newOwnerUserId: memberUserId } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    // No sub was ever created → no Stripe customer for either party.
    expect(await h.app.gateways.stripe.findCustomerByEmail("carol@example.com")).toBeNull();
    expect(await h.app.gateways.stripe.findCustomerByEmail("dave@example.com")).toBeNull();

    const dave = { authorization: `Bearer ${await login("dave")}`, "x-household-id": householdId };
    const members = (await h.app.inject({ method: "GET", url: `/households/${householdId}/members`, headers: dave })).json().members as Array<{ role: string }>;
    expect(members).toHaveLength(1);
    expect(members[0]!.role).toBe("owner");
  });

  it("target is a teen → TRANSFER_TARGET_INELIGIBLE", async () => {
    const { householdId, memberUserId, ownerHeaders } = await setupHousehold({ ownerToken: "erin", memberToken: "frank", role: "teen" });
    const res = await h.app.inject({ method: "POST", url: `/households/${householdId}/transfer-ownership`, headers: ownerHeaders, payload: { newOwnerUserId: memberUserId } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("HH-T0006");
  });

  it("target is a viewer → TRANSFER_TARGET_INELIGIBLE", async () => {
    const { householdId, memberUserId, ownerHeaders } = await setupHousehold({ ownerToken: "gina", memberToken: "heidi", role: "viewer" });
    const res = await h.app.inject({ method: "POST", url: `/households/${householdId}/transfer-ownership`, headers: ownerHeaders, payload: { newOwnerUserId: memberUserId } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("HH-T0006");
  });

  it("target is a nonexistent user → TRANSFER_TARGET_INELIGIBLE", async () => {
    const owner = { authorization: `Bearer ${await login("ivan")}` };
    const hh = await h.app.inject({ method: "POST", url: "/households", headers: owner, payload: { name: "Solo", type: "individual" } });
    const householdId = hh.json().id as string;
    const ownerHeaders = { ...owner, "x-household-id": householdId };
    const res = await h.app.inject({ method: "POST", url: `/households/${householdId}/transfer-ownership`, headers: ownerHeaders, payload: { newOwnerUserId: "00000000-0000-0000-0000-000000000000" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("HH-T0006");
  });

  it("target is the caller themselves → TRANSFER_TARGET_INELIGIBLE", async () => {
    const owner = { authorization: `Bearer ${await login("judy")}` };
    const hh = await h.app.inject({ method: "POST", url: "/households", headers: owner, payload: { name: "Solo", type: "individual" } });
    const householdId = hh.json().id as string;
    const ownerHeaders = { ...owner, "x-household-id": householdId };
    const me = (await h.app.inject({ method: "GET", url: `/households/${householdId}/members`, headers: ownerHeaders })).json().members[0];
    const res = await h.app.inject({ method: "POST", url: `/households/${householdId}/transfer-ownership`, headers: ownerHeaders, payload: { newOwnerUserId: me.userId } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("HH-T0006");
  });

  it("non-owner caller → 403", async () => {
    const { householdId, memberUserId } = await setupHousehold({ ownerToken: "kate", memberToken: "leo", role: "adult" });
    const leo = { authorization: `Bearer ${await login("leo")}`, "x-household-id": householdId };
    // adult member tries to transfer to themselves → rejected by requireHouseholdRole("owner")
    const res = await h.app.inject({ method: "POST", url: `/households/${householdId}/transfer-ownership`, headers: leo, payload: { newOwnerUserId: memberUserId } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("HH-T0003");
  });

  it("Stripe email collision → SUB-T0007 and DB unchanged", async () => {
    const { householdId, memberUserId, ownerHeaders } = await setupHousehold({ ownerToken: "mia", memberToken: "nick", role: "adult" });

    // Owner (mia) starts a paid sub → mia@example.com maps to customer A.
    await h.app.inject({ method: "POST", url: `/households/${householdId}/subscription/checkout`, headers: ownerHeaders, payload: { interval: "monthly" } });
    (h.app.gateways.stripe as any).confirmAll();

    // Target (nick) already owns a DIFFERENT Stripe customer via his own paid household.
    const nick = { authorization: `Bearer ${await login("nick")}` };
    const nickHh = await h.app.inject({ method: "POST", url: "/households", headers: nick, payload: { name: "Nick", type: "individual" } });
    const nickHhId = nickHh.json().id as string;
    const nickHeaders = { ...nick, "x-household-id": nickHhId };
    await h.app.inject({ method: "POST", url: `/households/${nickHhId}/subscription/checkout`, headers: nickHeaders, payload: { interval: "monthly" } });
    (h.app.gateways.stripe as any).confirmAll();
    const nickCustomer = await h.app.gateways.stripe.findCustomerByEmail("nick@example.com");
    expect(nickCustomer).toBeTruthy();

    const res = await h.app.inject({ method: "POST", url: `/households/${householdId}/transfer-ownership`, headers: ownerHeaders, payload: { newOwnerUserId: memberUserId } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("SUB-T0007");

    // DB unchanged: mia still owner, nick still adult (Stripe step precedes the swap).
    const members = (await h.app.inject({ method: "GET", url: `/households/${householdId}/members`, headers: ownerHeaders })).json().members as Array<{ userId: string; role: string }>;
    expect(members.find((m) => m.role === "owner")).toBeTruthy();
    expect(members.find((m) => m.userId === memberUserId)?.role).toBe("adult");
    // nick's own customer untouched.
    expect(await h.app.gateways.stripe.findCustomerByEmail("nick@example.com")).toBe(nickCustomer);
  });
});
