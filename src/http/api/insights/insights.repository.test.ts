import { describe, expect, it } from "vitest";
import { createInsightsRepository } from "./insights.repository.js";

describe("createInsightsRepository", () => {
  it("exposes the insights interface", () => {
    const repo = createInsightsRepository({} as never);
    for (const m of ["categorySums","netAllTime","goalsFor","listActive","latestGeneratedAt","replaceAll"]) {
      expect(typeof (repo as unknown as Record<string, unknown>)[m]).toBe("function");
    }
  });
});
