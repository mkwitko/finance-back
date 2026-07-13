import type { FastifyPluginAsync } from "fastify";
import { listUsersRoute } from "./list-users/list-users.controller.js";

export const usersRoutes: FastifyPluginAsync = async (app) => {
  await app.register(listUsersRoute);
};
