import type { GoogleGateway } from "../../../../gateways/google/google.gateway.js";
import type { AccessTokenClaims, AuthTokens } from "../../../../types/auth.js";
import type { UsersRepository } from "../../users/users.repository.js";
import type { AuthRepository } from "../auth.repository.js";
import { generateRefreshToken, hashToken } from "../tokens.js";

export type GoogleLoginDeps = {
  google: GoogleGateway;
  usersRepo: UsersRepository;
  authRepo: AuthRepository;
  issueAccessToken: (claims: AccessTokenClaims) => string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
};

export function createGoogleLoginService(deps: GoogleLoginDeps) {
  return async (input: { idToken: string }): Promise<AuthTokens> => {
    // 1. Verify the Google ID token (audience = configured client IDs). Throws AUTH-T0004.
    const identity = await deps.google.verifyIdToken(input.idToken);

    // 2. Upsert the user by Google sub.
    const user = await deps.usersRepo.upsertByGoogle({
      googleSub: identity.sub,
      email: identity.email,
      name: identity.name,
      picture: identity.picture,
      emailVerified: identity.emailVerified,
    });

    // 3. Issue the short-lived app access JWT (identity only — no authorization claims).
    const accessToken = deps.issueAccessToken({
      sub: user.uuid,
      email: user.email,
      name: user.name,
    });

    // 4. Issue + persist (hashed) a rotatable refresh token.
    const refreshToken = generateRefreshToken();
    await deps.authRepo.insertRefreshToken({
      userId: user.uuid,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + deps.refreshTtlSeconds * 1000),
      actorUuid: user.uuid,
    });

    return { accessToken, refreshToken, expiresIn: deps.accessTtlSeconds };
  };
}
