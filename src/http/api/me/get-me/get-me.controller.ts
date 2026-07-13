import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { db } from "../../../../infra/db/client.js";
import { requireUser } from "../../../hooks/auth/auth.js";
import { createUsersRepository } from "../../users/users.repository.js";
import { MeResponse } from "./get-me.schema.js";
import { createGetMeService } from "./get-me.service.js";

export const getMeRoute: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/me",
    {
      // Authenticated only (no persona check) — enforced by the global auth hook.
      schema: {
        operationId: "getMe",
        tags: ["me"],
        summary: "Current authenticated user",
        response: { 200: MeResponse },
      },
    },
    async (req, reply) => {
      const service = createGetMeService({ usersRepo: createUsersRepository(db) });
      const user = await service({ userUuid: requireUser(req).sub });
      return reply.code(200).send({
        id: user.uuid,
        email: user.email,
        name: user.name,
        picture: user.picture,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      });
    },
  );
};
