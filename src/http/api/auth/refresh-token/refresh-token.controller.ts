import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { env } from "../../../../config/env.js";
import { db } from "../../../../infra/db/client.js";
import { createUsersRepository } from "../../users/users.repository.js";
import { createAuthRepository } from "../auth.repository.js";
import { AuthTokensResponse } from "../auth.schema.js";
import { RefreshTokenBody } from "./refresh-token.schema.js";
import { createRefreshService } from "./refresh-token.service.js";

export const refreshTokenRoute: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/auth/refresh",
    {
      // Public: rotation is authenticated by the refresh token itself, not the access JWT.
      config: { public: true },
      schema: {
        operationId: "authRefresh",
        tags: ["auth"],
        summary: "Rotate a refresh token for a new access + refresh pair",
        body: RefreshTokenBody,
        response: { 200: AuthTokensResponse },
      },
    },
    async (req, reply) => {
      const service = createRefreshService({
        usersRepo: createUsersRepository(db),
        authRepo: createAuthRepository(db),
        issueAccessToken: (claims) => app.jwt.sign(claims),
        accessTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
        refreshTtlSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
      });
      const result = await service({ refreshToken: req.body.refreshToken });
      return reply.code(200).send(result);
    },
  );
};
