import type { AuthRepository } from "../auth.repository.js";
import { hashToken } from "../tokens.js";

export type LogoutDeps = {
  authRepo: AuthRepository;
};

export function createLogoutService(deps: LogoutDeps) {
  // Idempotent: revoking an unknown/already-revoked token is a no-op.
  return async (input: { refreshToken: string }): Promise<void> => {
    await deps.authRepo.revokeByHash(hashToken(input.refreshToken));
  };
}
