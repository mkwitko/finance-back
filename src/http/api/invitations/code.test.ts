import { describe, expect, it } from "vitest";
import { generateInviteCode } from "./code.js";

describe("generateInviteCode", () => {
  it("produces a 10-char code from the safe alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const c = generateInviteCode();
      expect(c).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789]{10}$/);
    }
  });

  it("is effectively unique across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateInviteCode());
    expect(seen.size).toBeGreaterThan(995);
  });
});
