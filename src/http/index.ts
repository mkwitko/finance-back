import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod/v4";
import { accountsRoutes } from "./api/accounts/index.js";
import { authRoutes } from "./api/auth/index.js";
import { categoriesRoutes } from "./api/categories/index.js";
import { householdsRoutes } from "./api/households/index.js";
import { importsRoutes } from "./api/imports/index.js";
import { invitationsRoutes } from "./api/invitations/index.js";
import { meRoutes } from "./api/me/index.js";
import { membersRoutes } from "./api/households/members.routes.js";
import { transactionsRoutes } from "./api/transactions/index.js";
import { usersRoutes } from "./api/users/index.js";
import { authHook } from "./hooks/auth/auth.js";

const HealthResponse = z.object({ status: z.literal("ok") });

// Every route registered here requires a valid token by default via the global auth
// preHandler. Opt out with `config: { public: true }`. There is no role/persona
// authorization — authenticated is all that is required. The OpenAPI surfaces
// (/docs, /docs/json, /openapi.json) live OUTSIDE this plugin, so they are reachable
// without a token and need no `public` flag.
export const httpRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authHook);

  app.withTypeProvider<ZodTypeProvider>().get(
    "/health",
    {
      config: { public: true },
      schema: {
        operationId: "getHealth",
        tags: ["health"],
        summary: "Liveness probe",
        response: { 200: HealthResponse },
      },
    },
    async () => ({ status: "ok" }) as const,
  );

  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(usersRoutes);
  await app.register(householdsRoutes);
  await app.register(membersRoutes);
  await app.register(invitationsRoutes);
  await app.register(accountsRoutes);
  await app.register(categoriesRoutes);
  await app.register(transactionsRoutes);
  await app.register(importsRoutes);
};
