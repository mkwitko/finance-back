import { defineConfig } from "prisma/config";

// The Prisma CLI does NOT read process.env from a dotenv file on its own once a
// config file exists. Load `.env.local` here so every bare `prisma <cmd>`
// (generate, migrate, validate, postinstall) sees DATABASE_URL in local dev.
// In CI / the production container the file is absent — `loadEnvFile` would
// throw, so we swallow that and fall back to the real process environment
// (Neon URL injected as a container ENV / CI secret).
try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local not present — rely on the ambient process environment.
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
});
