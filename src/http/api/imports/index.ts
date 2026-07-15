import type { FastifyPluginAsync } from "fastify";
import { commitImportRoute } from "./commit-import/commit-import.controller.js";
import { createImportRoute } from "./create-import/create-import.controller.js";
import { previewImportRoute } from "./preview-import/preview-import.controller.js";

export const importsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(createImportRoute);
  await app.register(previewImportRoute);
  await app.register(commitImportRoute);
};
