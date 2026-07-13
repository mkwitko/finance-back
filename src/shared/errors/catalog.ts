import { AppError, type ErrorDetails } from "./app-error.js";

type ErrorFactory = (details?: ErrorDetails) => AppError;

function make(code: string, statusCode: number, internalMessage: string): ErrorFactory {
  return (details) => new AppError(code, statusCode, internalMessage, details);
}

/**
 * Error inventory. Codes follow `SIGLA-TNNNN` (T = technical). Adding a code means:
 * add the entry here + the string in the three `i18n/<locale>.json` bundles.
 */
export const ERRORS = {
  AUTH: {
    MISSING_TOKEN: make("AUTH-T0001", 401, "missing_token"),
    INVALID_TOKEN: make("AUTH-T0002", 401, "invalid_token"),
    TOKEN_EXPIRED: make("AUTH-T0003", 401, "token_expired"),
    GOOGLE_VERIFICATION_FAILED: make("AUTH-T0004", 401, "google_verification_failed"),
    REFRESH_TOKEN_INVALID: make("AUTH-T0005", 401, "refresh_token_invalid"),
    REFRESH_TOKEN_REVOKED: make("AUTH-T0006", 401, "refresh_token_revoked"),
    REFRESH_TOKEN_EXPIRED: make("AUTH-T0007", 401, "refresh_token_expired"),
    USER_NOT_FOUND: make("AUTH-T0008", 404, "user_not_found"),
  },
  HOUSEHOLD: {
    MISSING_CONTEXT: make("HH-T0001", 400, "household_context_missing"),
    NOT_A_MEMBER: make("HH-T0002", 403, "household_not_a_member"),
    INSUFFICIENT_ROLE: make("HH-T0003", 403, "household_insufficient_role"),
    NOT_FOUND: make("HH-T0004", 404, "household_not_found"),
    LAST_OWNER: make("HH-T0005", 409, "household_last_owner"),
  },
  INVITATION: {
    NOT_FOUND: make("INV-T0001", 404, "invitation_not_found"),
    EXPIRED: make("INV-T0002", 410, "invitation_expired"),
    ALREADY_MEMBER: make("INV-T0003", 409, "invitation_already_member"),
    ROLE_TOO_HIGH: make("INV-T0004", 403, "invitation_role_too_high"),
  },
  RESOURCE: {
    NOT_FOUND: make("RES-T0001", 404, "resource_not_found"),
  },
  SYS: {
    INTERNAL: make("SYS-T0001", 500, "internal_server_error"),
    VALIDATION: make("SYS-T0002", 400, "validation_error"),
    RATE_LIMITED: make("SYS-T0003", 429, "rate_limited"),
    SERVICE_UNAVAILABLE: make("SYS-T0004", 503, "service_unavailable"),
  },
} as const;
