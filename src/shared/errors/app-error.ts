export type ErrorDetails = Record<string, unknown>;

/**
 * Base typed error. Never construct directly in feature code — throw via the
 * catalog factory (`ERRORS.<SIGLA>.<NAME>(...)`). The global error handler maps
 * `code`/`statusCode` to the HTTP envelope and resolves the i18n `message` from
 * `code`.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    public readonly internalMessage: string,
    public readonly details?: ErrorDetails,
  ) {
    super(internalMessage);
    this.name = "AppError";
  }
}

/** Preserve the upstream/root cause for logs without leaking it to the client. */
export function withCause(err: AppError, cause: unknown): AppError {
  err.cause = cause;
  return err;
}
