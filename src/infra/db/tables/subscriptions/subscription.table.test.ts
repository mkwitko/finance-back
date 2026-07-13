import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { SUBSCRIPTION_PLANS, subscription } from "./subscription.table.js";

describe("subscription table", () => {
  it("has expected columns", () => {
    const cols = Object.keys(getTableColumns(subscription));
    for (const c of [
      "id",
      "uuid",
      "householdId",
      "plan",
      "status",
      "provider",
      "providerRef",
      "currentPeriodEnd",
      "deletedAt",
    ]) {
      expect(cols).toContain(c);
    }
  });

  it("exposes plans", () => {
    expect(SUBSCRIPTION_PLANS).toContain("premium");
  });
});
