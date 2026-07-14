import { ERRORS } from "../../../../shared/errors/catalog.js";
import type { AccessTokenClaims, AuthTokens } from "../../../../types/auth.js";
import type { UsersRepository } from "../../users/users.repository.js";
import type { AuthRepository } from "../auth.repository.js";
import { generateRefreshToken, hashToken } from "../tokens.js";

export type RefreshDeps = {
  usersRepo: UsersRepository;
  authRepo: AuthRepository;
  issueAccessToken: (claims: AccessTokenClaims) => string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
};

export function createRefreshService(deps: RefreshDeps) {
  return async (input: { refreshToken: string }): Promise<AuthTokens> => {
    const stored = await deps.authRepo.findByHash(hashToken(input.refreshToken));
    if (!stored) throw ERRORS.AUTH.REFRESH_TOKEN_INVALID();
    if (stored.revokedAt) throw ERRORS.AUTH.REFRESH_TOKEN_REVOKED();
    if (stored.expiresAt.getTime() <= Date.now()) throw ERRORS.AUTH.REFRESH_TOKEN_EXPIRED();

    const user = await deps.usersRepo.findById(stored.userId);
    if (!user) throw ERRORS.AUTH.USER_NOT_FOUND();

    // Rotate: revoke the presented token and issue a fresh pair.
    const newRefresh = generateRefreshToken();
    await deps.authRepo.rotate({
      oldId: stored.id,
      userId: user.uuid,
      newHash: hashToken(newRefresh),
      expiresAt: new Date(Date.now() + deps.refreshTtlSeconds * 1000),
      actorUuid: user.uuid,
    });

    const accessToken = deps.issueAccessToken({
      sub: user.uuid,
      email: user.email,
      name: user.name,
    });

    return { accessToken, refreshToken: newRefresh, expiresIn: deps.accessTtlSeconds };
  };
}
