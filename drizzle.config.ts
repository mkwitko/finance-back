import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/**/*.table.ts",
  out: "./src/infra/db/migrations",
  casing: "snake_case",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://finance:finance@localhost:5432/finance",
  },
  strict: true,
  verbose: true,
});
