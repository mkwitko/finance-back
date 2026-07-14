import { describe, it, expect } from "vitest";
import { createStripeGateway } from "./stripe.gateway.js";

describe("stripe gateway (disabled)", () => {
  const gw = createStripeGateway({ secretKey: "", publishableKey: "" });
  it("reports disabled", () => {
    expect(gw.enabled).toBe(false);
  });
  it("throws STRIPE_DISABLED on a mutating call", async () => {
    await expect(gw.ensureCustomer("a@b.com")).rejects.toMatchObject({ code: "SUB-T0002" });
  });
});
