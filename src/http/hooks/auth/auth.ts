import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import { ERRORS } from "../../../shared/errors/catalog.js";
import type { AccessTokenClaims, AuthUser } from "../../../types/auth.js";

/** Extract the token from `Authorization`, tolerating an optional `Bearer` scheme. */
export function extractToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  return header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
}

/** Guarantee an authenticated user inside a handler (identity from the access JWT). */
export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw ERRORS.AUTH.INVALID_TOKEN();
  return req.user;
}

// Verifies the app access JWT (@fastify/jwt) and attaches `req.user`. Short-circuits
// for routes flagged `config: { public: true }` (e.g. /health, /auth/google,
// /auth/refresh). Every other route simply requires a valid token — there is no
// role/persona authorization layer.
export const authHook: preHandlerHookHandler = async (req) => {
  if (req.routeOptions.config.public) return;

  const token = extractToken(req);
  if (!token) throw ERRORS.AUTH.MISSING_TOKEN();

  let claims: AccessTokenClaims;
  try {
    claims = req.server.jwt.verify<AccessTokenClaims>(token);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "FAST_JWT_EXPIRED") throw ERRORS.AUTH.TOKEN_EXPIRED();
    throw ERRORS.AUTH.INVALID_TOKEN();
  }

  req.user = { sub: claims.sub, email: claims.email, name: claims.name };
};
