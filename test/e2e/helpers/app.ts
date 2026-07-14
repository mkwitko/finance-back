import { execFileSync } from "node:child_process";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import type { Gateways } from "../../../src/types/fastify.js";
import { buildFakeGateways } from "../../mocks/gateways.fake.js";
import { setTestEnv } from "./env.js";

export type TestApp = {
  app: FastifyInstance;
  close: () => Promise<void>;
};

// Boots a real Postgres via Testcontainers, applies the Prisma schema, then builds the
// app with fake gateways. Requires Docker (and a generated @prisma/client — run
// `npx prisma generate` beforehand if it's stale).
export async function buildTestApp(gatewayOverrides: Partial<Gateways> = {}): Promise<TestApp> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const uri = container.getConnectionUri();
  setTestEnv({ DATABASE_URL: uri });

  execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
    env: { ...process.env, DATABASE_URL: uri },
    stdio: "inherit",
  });

  const { buildApp } = await import("../../../src/app.js");
  const app = await buildApp({ gateways: buildFakeGateways(gatewayOverrides), rateLimit: false });
  await app.ready();

  return {
    app,
    close: async () => {
      await app.close();
      await container.stop();
    },
  };
}
