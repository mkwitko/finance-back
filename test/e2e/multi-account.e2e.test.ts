import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "./helpers/app.js";

describe("multi-account: invitations + members e2e (db)", () => {
  let h: TestApp;
  async function login(idToken: string) {
    const res = await h.app.inject({ method: "POST", url: "/auth/google", payload: { idToken } });
    expect(res.statusCode).toBe(200);
    return res.json().accessToken as string;
  }
  beforeAll(async () => { h = await buildTestApp(); }, 120_000);
  afterAll(async () => { await h.close(); });

  it("owner invites, invitee redeems and becomes a member", async () => {
    const owner = { authorization: `Bearer ${await login("alice")}` };
    const hh = await h.app.inject({ method: "POST", url: "/households", headers: owner, payload: { name: "Casa", type: "shared" } });
    const householdId = hh.json().id as string;
    const ownerHh = { ...owner, "x-household-id": householdId };

    const inv = await h.app.inject({ method: "POST", url: `/households/${householdId}/invitations`, headers: ownerHh, payload: { role: "adult" } });
    expect(inv.statusCode).toBe(201);
    const { code } = inv.json();
    expect(code).toMatch(/^[A-Za-z0-9]{10}$/);

    const bob = { authorization: `Bearer ${await login("bob")}` };
    const redeem = await h.app.inject({ method: "POST", url: `/invitations/${code}/redeem`, headers: bob });
    expect(redeem.statusCode).toBe(200);
    expect(redeem.json().id).toBe(householdId);

    // Bob now sees the household and can list members (2).
    const membersRes = await h.app.inject({ method: "GET", url: `/households/${householdId}/members`, headers: { ...bob, "x-household-id": householdId } });
    expect(membersRes.statusCode).toBe(200);
    expect(membersRes.json().members).toHaveLength(2);

    // Re-redeem is rejected (already a member).
    const again = await h.app.inject({ method: "POST", url: `/invitations/${code}/redeem`, headers: bob });
    expect(again.statusCode).toBe(409);
  });

  it("rejects an invite role above the inviter's role", async () => {
    const owner = { authorization: `Bearer ${await login("carol")}` };
    const hh = await h.app.inject({ method: "POST", url: "/households", headers: owner, payload: { name: "Fam", type: "family" } });
    const householdId = hh.json().id as string;
    const ownerHh = { ...owner, "x-household-id": householdId };
    // Owner invites an adult; adult tries to mint an owner invite → 403.
    const inv = await h.app.inject({ method: "POST", url: `/households/${householdId}/invitations`, headers: ownerHh, payload: { role: "adult" } });
    const dave = { authorization: `Bearer ${await login("dave")}` };
    await h.app.inject({ method: "POST", url: `/invitations/${inv.json().code}/redeem`, headers: dave });
    const daveHh = { ...dave, "x-household-id": householdId };
    const bad = await h.app.inject({ method: "POST", url: `/households/${householdId}/invitations`, headers: daveHh, payload: { role: "owner" } });
    expect(bad.statusCode).toBe(403);
  });

  it("blocks demoting or removing the last owner", async () => {
    const owner = { authorization: `Bearer ${await login("erin")}` };
    const hh = await h.app.inject({ method: "POST", url: "/households", headers: owner, payload: { name: "Solo", type: "individual" } });
    const householdId = hh.json().id as string;
    const ownerHh = { ...owner, "x-household-id": householdId };
    // Resolve own userId (uuid) via members list.
    const me = (await h.app.inject({ method: "GET", url: `/households/${householdId}/members`, headers: ownerHh })).json().members[0];
    const demote = await h.app.inject({ method: "PATCH", url: `/households/${householdId}/members/${me.userId}`, headers: ownerHh, payload: { role: "adult" } });
    expect(demote.statusCode).toBe(409);
    const leave = await h.app.inject({ method: "DELETE", url: `/households/${householdId}/members/${me.userId}`, headers: ownerHh });
    expect(leave.statusCode).toBe(409);
  });

  it("rejects an expired/unknown code", async () => {
    const bob = { authorization: `Bearer ${await login("frank")}` };
    const res = await h.app.inject({ method: "POST", url: `/invitations/ZZZZZZZZZZ/redeem`, headers: bob });
    expect(res.statusCode).toBe(410);
  });
});
