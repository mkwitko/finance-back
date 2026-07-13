import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "./helpers/app.js";

// DB-backed flow: Google login provisions the user, then /me returns it, then refresh
// rotates and revokes the old token. Requires Docker (Testcontainers Postgres).
describe("auth + me e2e (db)", () => {
  let h: TestApp;

  beforeAll(async () => {
    h = await buildTestApp();
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  it("logs in with Google, reads /me, then rotates and revokes the refresh token", async () => {
    const login = await h.app.inject({
      method: "POST",
      url: "/auth/google",
      payload: { idToken: "alice" },
    });
    expect(login.statusCode).toBe(200);
    const { accessToken, refreshToken, expiresIn } = login.json();
    expect(expiresIn).toBe(900);

    const me = await h.app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body.email).toBe("alice@example.com");

    const refreshed = await h.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().refreshToken).not.toBe(refreshToken);

    // The old refresh token is now revoked.
    const reuse = await h.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().code).toBe("AUTH-T0006");
  });
});
