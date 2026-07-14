import { describe, it, expect } from "vitest";
import { parseEnv } from "./env.js";

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://x",
  JWT_SECRET: "0123456789abcdef",
  GOOGLE_CLIENT_IDS: "cid",
};

describe("env stripe", () => {
  it("defaults stripe vars to empty string when unset", () => {
    const env = parseEnv(base);
    expect(env.STRIPE_SECRET_KEY).toBe("");
    expect(env.STRIPE_PRICE_PREMIUM_MONTHLY).toBe("");
  });
  it("reads stripe vars when set", () => {
    const env = parseEnv({ ...base, STRIPE_SECRET_KEY: "sk_test_1", STRIPE_PRICE_PREMIUM_MONTHLY: "price_m" });
    expect(env.STRIPE_SECRET_KEY).toBe("sk_test_1");
    expect(env.STRIPE_PRICE_PREMIUM_MONTHLY).toBe("price_m");
  });
});
