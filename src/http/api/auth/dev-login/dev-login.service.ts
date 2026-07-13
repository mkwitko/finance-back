import type { AccessTokenClaims, AuthTokens } from "../../../../types/auth.js";
import type { UsersRepository } from "../../users/users.repository.js";
import type { AuthRepository } from "../auth.repository.js";
import { generateRefreshToken, hashToken } from "../tokens.js";

// Development-only login: mints app tokens for any email WITHOUT Google, so the app
// can run against a local backend before Google OAuth is configured. Mirrors the
// Google flow (upsert → access JWT → hashed refresh) but keys the user by a synthetic
// `dev:<email>` subject so it never collides with a real Google `sub`.
export type DevLoginDeps = {
  usersRepo: UsersRepository;
  authRepo: AuthRepository;
  issueAccessToken: (claims: AccessTokenClaims) => string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
};

export function createDevLoginService(deps: DevLoginDeps) {
  return async (input: { email: string; name: string | undefined }): Promise<AuthTokens> => {
    const user = await deps.usersRepo.upsertByGoogle({
      googleSub: `dev:${input.email}`,
      email: input.email,
      name: input.name ?? input.email,
      picture: null,
      emailVerified: true,
    });

    const accessToken = deps.issueAccessToken({
      sub: user.uuid,
      email: user.email,
      name: user.name,
    });

    const refreshToken = generateRefreshToken();
    await deps.authRepo.insertRefreshToken({
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + deps.refreshTtlSeconds * 1000),
      actorUuid: user.uuid,
    });

    return { accessToken, refreshToken, expiresIn: deps.accessTtlSeconds };
  };
}
