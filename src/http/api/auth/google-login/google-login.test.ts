import { describe, expect, it, vi } from "vitest";
import type { GoogleGateway } from "../../../../gateways/google/google.gateway.js";
import { ERRORS } from "../../../../shared/errors/catalog.js";
import type { AccessTokenClaims } from "../../../../types/auth.js";
import type { UsersRepository } from "../../users/users.repository.js";
import type { User } from "../../users/users.types.js";
import type { AuthRepository } from "../auth.repository.js";
import { createGoogleLoginService } from "./google-login.service.js";

const USER: User = {
  uuid: "user-uuid",
  email: "alice@example.com",
  name: "Alice",
  picture: null,
  emailVerified: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function makeDeps() {
  const google: GoogleGateway = {
    verifyIdToken: vi.fn(async () => ({
      sub: "g-sub",
      email: USER.email,
      name: USER.name,
      picture: null,
      emailVerified: true,
    })),
  };
  const usersRepo = {
    upsertByGoogle: vi.fn(async () => USER),
    findByUuid: vi.fn(),
    listUsers: vi.fn(),
  } as unknown as UsersRepository;
  const authRepo = {
    insertRefreshToken: vi.fn(async () => undefined),
    findByHash: vi.fn(),
    rotate: vi.fn(),
    revokeByHash: vi.fn(),
  } as unknown as AuthRepository;
  const issued: AccessTokenClaims[] = [];
  const issueAccessToken = vi.fn((claims: AccessTokenClaims) => {
    issued.push(claims);
    return "access.jwt";
  });
  return { google, usersRepo, authRepo, issueAccessToken, issued };
}

describe("googleLogin service", () => {
  it("verifies the google token, upserts the user and returns a token pair", async () => {
    const deps = makeDeps();
    const service = createGoogleLoginService({
      ...deps,
      accessTtlSeconds: 900,
      refreshTtlSeconds: 1_000,
    });

    const result = await service({ idToken: "the-token" });

    expect(deps.google.verifyIdToken).toHaveBeenCalledWith("the-token");
    expect(deps.usersRepo.upsertByGoogle).toHaveBeenCalledOnce();
    expect(deps.authRepo.insertRefreshToken).toHaveBeenCalledOnce();
    expect(result.accessToken).toBe("access.jwt");
    expect(result.expiresIn).toBe(900);
    expect(result.refreshToken.length).toBeGreaterThan(20);
    // the access token carries identity only — no authorization claims
    expect(deps.issued[0]).toEqual({
      sub: "user-uuid",
      email: "alice@example.com",
      name: "Alice",
    });
  });

  it("propagates AUTH-T0004 when google verification fails", async () => {
    const deps = makeDeps();
    deps.google.verifyIdToken = vi.fn(async () => {
      throw ERRORS.AUTH.GOOGLE_VERIFICATION_FAILED();
    });
    const service = createGoogleLoginService({
      ...deps,
      accessTtlSeconds: 900,
      refreshTtlSeconds: 1_000,
    });

    await expect(service({ idToken: "bad" })).rejects.toMatchObject({ code: "AUTH-T0004" });
    expect(deps.authRepo.insertRefreshToken).not.toHaveBeenCalled();
  });
});
