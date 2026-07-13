import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import type { Gateways } from "../../../src/types/fastify.js";
import { buildFakeGateways } from "../../mocks/gateways.fake.js";
import { setTestEnv } from "./env.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export type TestApp = {
  app: FastifyInstance;
  pool: Pool;
  close: () => Promise<void>;
};

// Boots a real Postgres via Testcontainers, runs migrations, then builds the app with
// fake gateways. Requires Docker.
export async function buildTestApp(gatewayOverrides: Partial<Gateways> = {}): Promise<TestApp> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const uri = container.getConnectionUri();
  setTestEnv({ DATABASE_URL: uri });

  const pool = new Pool({ connectionString: uri, max: 5 });
  await migrate(drizzle(pool), {
    migrationsFolder: path.resolve(currentDir, "../../../src/infra/db/migrations"),
  });

  const { buildApp } = await import("../../../src/app.js");
  const app = await buildApp({ gateways: buildFakeGateways(gatewayOverrides), rateLimit: false });
  await app.ready();

  return {
    app,
    pool,
    close: async () => {
      await app.close();
      await pool.end();
      await container.stop();
    },
  };
}
