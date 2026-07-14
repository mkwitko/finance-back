import { describe, it, expect, beforeEach } from "vitest";
import { intervalForPriceId, planForPriceId, priceIdForInterval, statusFromStripe } from "./subscription.js";

beforeEach(() => {
  process.env.STRIPE_PRICE_PREMIUM_MONTHLY = "price_m";
  process.env.STRIPE_PRICE_PREMIUM_ANNUAL = "price_a";
});

describe("subscription domain", () => {
  it("maps interval to configured price id", () => {
    expect(priceIdForInterval("monthly")).toBe("price_m");
    expect(priceIdForInterval("annual")).toBe("price_a");
  });
  it("maps price id back to interval", () => {
    expect(intervalForPriceId("price_m")).toBe("monthly");
    expect(intervalForPriceId("price_a")).toBe("annual");
    expect(intervalForPriceId("price_unknown")).toBeNull();
  });
  it("maps configured price to premium plan, unknown to free", () => {
    expect(planForPriceId("price_m")).toBe("premium");
    expect(planForPriceId("price_x")).toBe("free");
  });
  it("normalizes stripe status", () => {
    expect(statusFromStripe("active", false)).toBe("active");
    expect(statusFromStripe("trialing", false)).toBe("active");
    expect(statusFromStripe("active", true)).toBe("active"); // still active until period end
    expect(statusFromStripe("canceled", false)).toBe("canceled");
    expect(statusFromStripe("incomplete", false)).toBe("expired");
  });
});
