import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFakeGateways } from "../mocks/gateways.fake.js";
import { setTestEnv } from "./helpers/env.js";

// These paths never touch the database (health is public; the 401s short-circuit in
// the auth preHandler), so no Testcontainers/Docker is required.
describe("health + auth guards (e2e)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    setTestEnv();
    const { buildApp } = await import("../../src/app.js");
    app = await buildApp({ gateways: buildFakeGateways(), rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health is public → 200", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("GET /me without a token → 401 AUTH-T0001", async () => {
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("AUTH-T0001");
  });

  it("exposes the OpenAPI document at /openapi.json (public)", async () => {
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    expect(res.json().openapi).toMatch(/^3\./);
  });
});
