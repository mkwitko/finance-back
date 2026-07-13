import { describe, expect, it } from "vitest";
import { entitlementsFor } from "./entitlements.js";
describe("entitlementsFor", () => {
  it("premium active unlocks features", () => {
    const e = entitlementsFor("premium", "active");
    expect(e.aiInsights).toBe(true);
    expect(e.futureProjection).toBe(true);
    expect(e.maxContexts).toBeGreaterThan(100);
  });
  it("free is limited", () => {
    expect(entitlementsFor("free", "active").aiInsights).toBe(false);
    expect(entitlementsFor("free", "active").maxContexts).toBe(2);
  });
  it("canceled premium reverts to free", () => {
    expect(entitlementsFor("premium", "canceled").aiInsights).toBe(false);
  });
});
