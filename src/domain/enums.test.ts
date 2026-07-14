import { describe, expect, it } from "vitest";
import { INSIGHT_KINDS, MEMBERSHIP_ROLES, ROLE_RANK, TRANSACTION_SOURCES } from "./enums.js";

describe("domain enums", () => {
  it("membership roles ranked owner→viewer", () => {
    expect(MEMBERSHIP_ROLES).toEqual(["owner", "adult", "teen", "child", "viewer"]);
    expect(ROLE_RANK.owner).toBeGreaterThan(ROLE_RANK.viewer);
  });
  it("carries insight + transaction enums", () => {
    expect(INSIGHT_KINDS).toContain("summary");
    expect(TRANSACTION_SOURCES).toContain("import");
  });
});
