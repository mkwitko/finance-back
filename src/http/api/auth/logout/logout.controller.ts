import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { db } from "../../../../infra/db/client.js";
import { createAuthRepository } from "../auth.repository.js";
import { LogoutBody } from "./logout.schema.js";
import { createLogoutService } from "./logout.service.js";

export const logoutRoute: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/auth/logout",
    {
      // Authenticated only: a signed-in user revokes their own refresh token.
      schema: {
        operationId: "authLogout",
        tags: ["auth"],
        summary: "Revoke a refresh token",
        body: LogoutBody,
      },
    },
    async (req, reply) => {
      const service = createLogoutService({ authRepo: createAuthRepository(db) });
      await service({ refreshToken: req.body.refreshToken });
      return reply.code(204).send();
    },
  );
};
