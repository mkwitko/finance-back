import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { jsonSchemaTransform, jsonSchemaTransformObject } from "fastify-type-provider-zod";

// OpenAPI (Zod schemas -> JSON Schema via the type-provider transforms). Registered
// BEFORE the routes so the `onRoute` hook captures each route's Zod schema. The
// document surfaces (no auth) let the mobile app generate a typed client via Kubb:
//   - /docs        Swagger UI (human)
//   - /docs/json   OpenAPI 3 document (Kubb source)
//   - /openapi.json alias of the OpenAPI document
const _swaggerPlugin: FastifyPluginAsync = async (app) => {
  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Finance API",
        description:
          "Finance backend — Fastify 5 + Zod + Drizzle. Custom JWT + Google Sign-In auth.",
        version: "0.1.0",
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  await app.register(fastifySwaggerUi, { routePrefix: "/docs" });

  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
};

export const swaggerPlugin = fp(_swaggerPlugin, { fastify: "5.x", name: "swagger" });
