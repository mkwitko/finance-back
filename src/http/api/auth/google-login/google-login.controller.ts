import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { env } from "../../../../config/env.js";
import { db } from "../../../../infra/db/client.js";
import { createUsersRepository } from "../../users/users.repository.js";
import { createAuthRepository } from "../auth.repository.js";
import { AuthTokensResponse } from "../auth.schema.js";
import { GoogleLoginBody } from "./google-login.schema.js";
import { createGoogleLoginService } from "./google-login.service.js";

export const googleLoginRoute: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/auth/google",
    {
      // Public: the caller has no app token yet — it presents a Google ID token.
      config: { public: true },
      schema: {
        operationId: "authGoogle",
        tags: ["auth"],
        summary: "Exchange a Google ID token for app access + refresh tokens",
        body: GoogleLoginBody,
        response: { 200: AuthTokensResponse },
      },
    },
    async (req, reply) => {
      const service = createGoogleLoginService({
        google: app.gateways.google,
        usersRepo: createUsersRepository(db),
        authRepo: createAuthRepository(db),
        issueAccessToken: (claims) => app.jwt.sign(claims),
        accessTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
        refreshTtlSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
      });
      const result = await service({ idToken: req.body.idToken });
      req.log.info("auth.google_login");
      return reply.code(200).send(result);
    },
  );
};
