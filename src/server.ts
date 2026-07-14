import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { closeDb, db } from "./infra/db/client.js";
import { logger } from "./infra/observability/logger.js";

const SHUTDOWN_TIMEOUT = 30_000;

async function main(): Promise<void> {
  const app = await buildApp();

  // Fail fast if the database is unreachable.
  await db.$queryRaw`select 1`;

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "server.ready");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutdown.start");

    const force = setTimeout(() => {
      logger.error("shutdown.timeout — forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT);

    try {
      await app.close();
      logger.info("shutdown.fastify_closed");
      await closeDb();
      logger.info("shutdown.db_closed");
      clearTimeout(force);
      logger.info("shutdown.complete");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "shutdown.error");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err }, "server.boot_failed");
  process.exit(1);
});
