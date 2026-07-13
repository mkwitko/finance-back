import { createHash, randomBytes } from "node:crypto";

/** Opaque refresh token (never a JWT) — a random 256-bit value, base64url-encoded. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Refresh tokens are stored hashed at rest (sha256 hex). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
