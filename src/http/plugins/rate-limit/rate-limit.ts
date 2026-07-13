import fastifyRateLimit from "@fastify/rate-limit";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { env } from "../../../config/env.js";
import { ERRORS } from "../../../shared/errors/catalog.js";
import { pickLocale, resolveMessage } from "../../../shared/errors/i18n.js";

// Global rate limit. Key is a hash of the bearer token when present, else the IP —
// so users behind the same NAT get separate buckets. `req.ip` is trustworthy because
// `trustProxy` is fixed to a hop count, never `true`.
const _rateLimitPlugin: FastifyPluginAsync = async (app) => {
  await app.register(fastifyRateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (req) => req.headers.authorization ?? req.ip,
    errorResponseBuilder: (req, _context) => {
      const err = ERRORS.SYS.RATE_LIMITED();
      const locale = pickLocale(req.headers["accept-language"]);
      return {
        status: err.statusCode,
        code: err.code,
        message: resolveMessage(err.code, locale),
        trace_id: req.id,
      };
    },
  });
};

export const rateLimitPlugin = fp(_rateLimitPlugin, { fastify: "5.x", name: "rate-limit" });
