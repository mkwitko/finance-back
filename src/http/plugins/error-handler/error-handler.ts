import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { env } from "../../../config/env.js";
import { AppError } from "../../../shared/errors/app-error.js";
import { ERRORS } from "../../../shared/errors/catalog.js";
import { pickLocale, resolveMessage } from "../../../shared/errors/i18n.js";

const _errorHandlerPlugin: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((err, req, reply) => {
    let appErr: AppError;
    if (err instanceof AppError) {
      appErr = err;
    } else if (hasZodFastifySchemaValidationErrors(err)) {
      appErr = ERRORS.SYS.VALIDATION({ issues: err.validation });
    } else {
      appErr = ERRORS.SYS.INTERNAL();
    }

    // 5xx are bugs -> log the full error; 4xx are expected -> warn with the code.
    if (appErr.statusCode >= 500) {
      req.log.error({ err }, appErr.internalMessage);
    } else {
      req.log.warn({ code: appErr.code }, appErr.internalMessage);
    }

    const locale = pickLocale(req.headers["accept-language"]);
    const body: Record<string, unknown> = {
      status: appErr.statusCode,
      code: appErr.code,
      message: resolveMessage(appErr.code, locale),
      trace_id: req.id,
    };

    // Verbose envelope everywhere except production.
    if (env.NODE_ENV !== "production") {
      body.internal_message = appErr.internalMessage;
      body.url = req.url;
      body.method = req.method;
      if (appErr.details) body.details = appErr.details;
      body.stack = appErr.stack;
    }

    return reply.code(appErr.statusCode).send(body);
  });
};

export const errorHandlerPlugin = fp(_errorHandlerPlugin, {
  fastify: "5.x",
  name: "error-handler",
});
