import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "./helpers/app.js";
describe("subscription e2e (db)", () => {
  let h: TestApp;
  async function login(t: string) { return (await h.app.inject({ method: "POST", url: "/auth/google", payload: { idToken: t } })).json().accessToken as string; }
  beforeAll(async () => { h = await buildTestApp(); }, 120_000);
  afterAll(async () => { await h.close(); });
  it("defaults to free, activates premium, cancels back to free", async () => {
    const auth = { authorization: `Bearer ${await login("alice")}` };
    const hh = await h.app.inject({ method: "POST", url: "/households", headers: auth, payload: { name: "Casa", type: "individual" } });
    const id = hh.json().id as string;
    const s = { ...auth, "x-household-id": id };
    const def = await h.app.inject({ method: "GET", url: `/households/${id}/subscription`, headers: s });
    expect(def.json()).toMatchObject({ plan: "free", entitlements: { aiInsights: false } });
    const act = await h.app.inject({ method: "POST", url: `/households/${id}/subscription/activate`, headers: s });
    expect(act.json()).toMatchObject({ plan: "premium", status: "active", entitlements: { aiInsights: true } });
    const get2 = await h.app.inject({ method: "GET", url: `/households/${id}/subscription`, headers: s });
    expect(get2.json().plan).toBe("premium");
    const can = await h.app.inject({ method: "POST", url: `/households/${id}/subscription/cancel`, headers: s });
    expect(can.json()).toMatchObject({ status: "canceled", entitlements: { aiInsights: false } });
  });
});
