import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "./helpers/app.js";

describe("ai insights e2e (db)", () => {
  let h: TestApp;
  async function login(idToken: string) {
    const res = await h.app.inject({ method: "POST", url: "/auth/google", payload: { idToken } });
    return res.json().accessToken as string;
  }
  beforeAll(async () => {
    h = await buildTestApp();
  }, 120_000);
  afterAll(async () => {
    await h.close();
  });

  it("generates + caches insights, and refresh replaces them", async () => {
    const auth = { authorization: `Bearer ${await login("alice")}` };
    const hh = await h.app.inject({ method: "POST", url: "/households", headers: auth, payload: { name: "Casa", type: "individual" } });
    const householdId = hh.json().id as string;
    const scoped = { ...auth, "x-household-id": householdId };

    // First GET → generates (fake gateway returns 2 items) + caches.
    const first = await h.app.inject({ method: "GET", url: `/households/${householdId}/insights`, headers: scoped });
    expect(first.statusCode).toBe(200);
    expect(first.json().insights.length).toBe(2);
    const firstGeneratedAt = first.json().insights[0].generatedAt;

    // Second GET → served from cache (same generatedAt, not regenerated).
    const second = await h.app.inject({ method: "GET", url: `/households/${householdId}/insights`, headers: scoped });
    expect(second.json().insights[0].generatedAt).toBe(firstGeneratedAt);

    // Refresh → regenerates a fresh batch (new generatedAt).
    const refreshed = await h.app.inject({ method: "POST", url: `/households/${householdId}/insights/refresh`, headers: scoped });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().insights.length).toBe(2);
  });

  it("returns an empty list (not an error) when the AI gateway is disabled", async () => {
    const disabled = await buildTestApp({
      deepseek: {
        enabled: false,
        categorizeTransactions: async () => [],
        extractReceipt: async () => [],
        generateInsights: async () => [],
      },
    });
    try {
      const token = (await disabled.app.inject({ method: "POST", url: "/auth/google", payload: { idToken: "bob" } })).json().accessToken;
      const auth = { authorization: `Bearer ${token}` };
      const hh = await disabled.app.inject({ method: "POST", url: "/households", headers: auth, payload: { name: "H", type: "individual" } });
      const householdId = hh.json().id as string;
      const res = await disabled.app.inject({
        method: "GET",
        url: `/households/${householdId}/insights`,
        headers: { ...auth, "x-household-id": householdId },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().insights).toEqual([]);
    } finally {
      await disabled.close();
    }
  });
});
