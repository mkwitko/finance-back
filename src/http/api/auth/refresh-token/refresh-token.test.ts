import { describe, expect, it, vi } from "vitest";
import type { AccessTokenClaims } from "../../../../types/auth.js";
import type { UsersRepository } from "../../users/users.repository.js";
import type { User } from "../../users/users.types.js";
import type { AuthRepository, StoredRefreshToken } from "../auth.repository.js";
import { createRefreshService } from "./refresh-token.service.js";

const USER: User = {
  id: 1,
  uuid: "user-uuid",
  email: "alice@example.com",
  name: "Alice",
  picture: null,
  emailVerified: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function makeDeps(stored: StoredRefreshToken | null) {
  const usersRepo = {
    findById: vi.fn(async () => USER),
    upsertByGoogle: vi.fn(),
    findByUuid: vi.fn(),
    listUsers: vi.fn(),
  } as unknown as UsersRepository;
  const authRepo = {
    findByHash: vi.fn(async () => stored),
    rotate: vi.fn(async () => undefined),
    insertRefreshToken: vi.fn(),
    revokeByHash: vi.fn(),
  } as unknown as AuthRepository;
  const issued: AccessTokenClaims[] = [];
  const issueAccessToken = vi.fn((claims: AccessTokenClaims) => {
    issued.push(claims);
    return "access.jwt";
  });
  return { usersRepo, authRepo, issueAccessToken, issued };
}

const svc = (deps: ReturnType<typeof makeDeps>) =>
  createRefreshService({ ...deps, accessTtlSeconds: 900, refreshTtlSeconds: 1_000 });

describe("refresh service", () => {
  it("rotates a valid refresh token and issues a fresh pair", async () => {
    const deps = makeDeps({
      id: 5,
      userId: 1,
      expiresAt: new Date(Date.now() + 100_000),
      revokedAt: null,
    });
    const result = await svc(deps)({ refreshToken: "some-token" });

    expect(deps.authRepo.rotate).toHaveBeenCalledOnce();
    expect(result.accessToken).toBe("access.jwt");
    expect(deps.issued[0]).toEqual({ sub: "user-uuid", email: "alice@example.com", name: "Alice" });
  });

  it("rejects an unknown token with AUTH-T0005", async () => {
    await expect(svc(makeDeps(null))({ refreshToken: "x" })).rejects.toMatchObject({
      code: "AUTH-T0005",
    });
  });

  it("rejects a revoked token with AUTH-T0006", async () => {
    const deps = makeDeps({
      id: 5,
      userId: 1,
      expiresAt: new Date(Date.now() + 100_000),
      revokedAt: new Date(),
    });
    await expect(svc(deps)({ refreshToken: "x" })).rejects.toMatchObject({ code: "AUTH-T0006" });
  });

  it("rejects an expired token with AUTH-T0007", async () => {
    const deps = makeDeps({
      id: 5,
      userId: 1,
      expiresAt: new Date(Date.now() - 1),
      revokedAt: null,
    });
    await expect(svc(deps)({ refreshToken: "x" })).rejects.toMatchObject({ code: "AUTH-T0007" });
  });
});
