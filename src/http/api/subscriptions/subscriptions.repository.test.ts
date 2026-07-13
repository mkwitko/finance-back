import { describe, expect, it } from "vitest";
import { createSubscriptionsRepository } from "./subscriptions.repository.js";
describe("createSubscriptionsRepository", () => {
  it("exposes the interface", () => {
    const r = createSubscriptionsRepository({} as never);
    for (const m of ["getForHousehold","upsertActive","cancel"]) expect(typeof (r as unknown as Record<string, unknown>)[m]).toBe("function");
  });
});
