import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { invitation } from "./invitation.table.js";

describe("invitation table", () => {
  it("has the expected columns", () => {
    const cols = Object.keys(getTableColumns(invitation));
    for (const c of ["id", "uuid", "householdId", "code", "role", "expiresAt", "revokedAt", "createdBy", "createdAt", "deletedAt"]) {
      expect(cols).toContain(c);
    }
  });
});
