import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { INSIGHT_KINDS, INSIGHT_SEVERITIES, insight } from "./insight.table.js";

describe("insight table", () => {
  it("has the expected columns", () => {
    const cols = Object.keys(getTableColumns(insight));
    for (const c of ["id","uuid","householdId","kind","severity","title","body","recommendation","periodStart","periodEnd","generatedAt","deletedAt"]) {
      expect(cols).toContain(c);
    }
  });
  it("exposes kind + severity enums", () => {
    expect(INSIGHT_KINDS).toContain("advice");
    expect(INSIGHT_SEVERITIES).toContain("warning");
  });
});
