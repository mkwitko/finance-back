import type { FastifyPluginAsync } from "fastify";
import { devLoginRoute } from "./dev-login/dev-login.controller.js";
import { googleLoginRoute } from "./google-login/google-login.controller.js";
import { logoutRoute } from "./logout/logout.controller.js";
import { refreshTokenRoute } from "./refresh-token/refresh-token.controller.js";

// Controllers declare full paths (/auth/...); registered without a prefix.
export const authRoutes: FastifyPluginAsync = async (app) => {
  await app.register(googleLoginRoute);
  await app.register(devLoginRoute);
  await app.register(refreshTokenRoute);
  await app.register(logoutRoute);
};
