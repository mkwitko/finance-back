import { defineConfig } from "vitest/config";

// Vitest 4: projects replace the standalone workspace file.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          setupFiles: ["./test/unit-setup.ts"],
        },
      },
      {
        test: {
          name: "e2e",
          environment: "node",
          include: ["test/e2e/**/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.schema.ts", "src/server.ts"],
      thresholds: { lines: 60, functions: 60, branches: 60, statements: 60 },
    },
  },
});
