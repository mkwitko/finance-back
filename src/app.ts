import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyJwt from "@fastify/jwt";
import fastifySensible from "@fastify/sensible";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { env } from "./config/env.js";
import { httpRoutes } from "./http/index.js";
import { errorHandlerPlugin } from "./http/plugins/error-handler/error-handler.js";
import { gatewaysPlugin } from "./http/plugins/gateways-plugin/gateways-plugin.js";
import { rateLimitPlugin } from "./http/plugins/rate-limit/rate-limit.js";
import { swaggerPlugin } from "./http/plugins/swagger/swagger.js";
import { closeDb } from "./infra/db/client.js";
import { logger } from "./infra/observability/logger.js";
import type { Gateways } from "./types/fastify.js";

export type BuildAppOptions = {
  gateways?: Gateways;
  rateLimit?: boolean;
};

function resolveCorsOrigin(): boolean | string[] {
  // Dev reflects the request origin; homolog/prod use an exact allowlist. Never `*`.
  if (env.NODE_ENV === "development") return true;
  return (
    env.CORS_ALLOWED_ORIGINS?.split(",")
      .map((o) => o.trim())
      .filter(Boolean) ?? []
  );
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    trustProxy: env.TRUST_PROXY_HOPS, // trusted hops (ALB), never `true`
    bodyLimit: 1_048_576,
    requestTimeout: 30_000,
  });

  // Zod as the source of truth: compiled validation + serialization via the type provider.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifySensible);
  await app.register(fastifyHelmet);
  await app.register(fastifyCors, {
    origin: resolveCorsOrigin(),
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE"],
  });

  // App JWT (custom auth). HS256 with an env secret to start; RS256 (key pair) is the
  // documented future option. fast-jwt `expiresIn` is in milliseconds.
  await app.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.ACCESS_TOKEN_TTL_SECONDS * 1000 },
  });

  await app.register(errorHandlerPlugin);
  if (opts.rateLimit ?? env.NODE_ENV !== "test") {
    await app.register(rateLimitPlugin);
  }
  await app.register(gatewaysPlugin, opts.gateways ? { gateways: opts.gateways } : {});
  await app.register(swaggerPlugin); // OpenAPI, before routes (onRoute captures schemas)
  await app.register(httpRoutes);

  // Tie the DB pool to the Fastify lifecycle so app.close() tears it down.
  app.addHook("onClose", async () => {
    await closeDb();
  });

  return app;
}
