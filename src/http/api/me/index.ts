import type { FastifyPluginAsync } from "fastify";
import { getMeRoute } from "./get-me/get-me.controller.js";

export const meRoutes: FastifyPluginAsync = async (app) => {
  await app.register(getMeRoute);
};
