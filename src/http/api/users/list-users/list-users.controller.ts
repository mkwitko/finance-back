import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { db } from "../../../../infra/db/client.js";
import { createUsersRepository } from "../users.repository.js";
import { ListUsersQuery, ListUsersResponse } from "./list-users.schema.js";
import { createListUsersService } from "./list-users.service.js";

export const listUsersRoute: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/users",
    {
      // Authenticated only (no persona check) — enforced by the global auth hook.
      schema: {
        operationId: "listUsers",
        tags: ["users"],
        summary: "List users",
        querystring: ListUsersQuery,
        response: { 200: ListUsersResponse },
      },
    },
    async (req, reply) => {
      const service = createListUsersService({ usersRepo: createUsersRepository(db) });
      const users = await service({ limit: req.query.limit });
      return reply.code(200).send({
        users: users.map((u) => ({
          id: u.uuid,
          email: u.email,
          name: u.name,
          emailVerified: u.emailVerified,
          createdAt: u.createdAt,
        })),
      });
    },
  );
};
