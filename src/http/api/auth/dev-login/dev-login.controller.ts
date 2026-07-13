import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { env } from "../../../../config/env.js";
import { db } from "../../../../infra/db/client.js";
import { ERRORS } from "../../../../shared/errors/catalog.js";
import { createUsersRepository } from "../../users/users.repository.js";
import { createAuthRepository } from "../auth.repository.js";
import { AuthTokensResponse } from "../auth.schema.js";
import { DevLoginBody } from "./dev-login.schema.js";
import { createDevLoginService } from "./dev-login.service.js";

export const devLoginRoute: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/auth/dev-login",
    {
      // Public, but only functional in development (returns 404 otherwise).
      config: { public: true },
      schema: {
        operationId: "authDevLogin",
        tags: ["auth"],
        summary: "Development-only login without Google (mints app tokens by email)",
        body: DevLoginBody,
        response: { 200: AuthTokensResponse },
      },
    },
    async (req, reply) => {
      if (env.NODE_ENV !== "development") throw ERRORS.RESOURCE.NOT_FOUND();
      const service = createDevLoginService({
        usersRepo: createUsersRepository(db),
        authRepo: createAuthRepository(db),
        issueAccessToken: (claims) => app.jwt.sign(claims),
        accessTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
        refreshTtlSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
      });
      const result = await service({ email: req.body.email, name: req.body.name });
      req.log.info("auth.dev_login");
      return reply.code(200).send(result);
    },
  );
};
