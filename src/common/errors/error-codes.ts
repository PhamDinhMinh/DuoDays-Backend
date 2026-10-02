/**
 * Stable, machine-readable error codes. Clients branch on these (and translate them);
 * `message` is developer-facing English only. Domain modules add their own codes here
 * when they land – never reuse a code for a different meaning.
 */
export const ErrorCode = {
  // Generic HTTP-level failures
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',

  // Auth
  EMAIL_ALREADY_EXISTS: 'EMAIL_ALREADY_EXISTS',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  REFRESH_TOKEN_EXPIRED: 'REFRESH_TOKEN_EXPIRED',
  REFRESH_TOKEN_REUSED: 'REFRESH_TOKEN_REUSED',

  // Couples
  ALREADY_IN_COUPLE: 'ALREADY_IN_COUPLE',
  COUPLE_NOT_FOUND: 'COUPLE_NOT_FOUND',
  COUPLE_NOT_PENDING: 'COUPLE_NOT_PENDING',

  // Couple invites
  /** No invite has this code (never issued, or already purged). */
  INVITE_NOT_FOUND: 'INVITE_NOT_FOUND',
  /**
   * The invite is no longer usable: EITHER its expiry passed (`now >= expiresAt`) OR it was
   * revoked (replaced by a newer code, or its couple was cancelled). Both mean "ask your
   * partner for a new code" – do not read this as "expiry time passed" only.
   */
  INVITE_EXPIRED: 'INVITE_EXPIRED',
  /** Someone else already joined with this invite. */
  INVITE_ALREADY_REDEEMED: 'INVITE_ALREADY_REDEEMED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Fallback code for an HTTP status when the thrower did not choose one. */
export function errorCodeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return ErrorCode.BAD_REQUEST;
    case 401:
      return ErrorCode.UNAUTHENTICATED;
    case 403:
      return ErrorCode.FORBIDDEN;
    case 404:
      return ErrorCode.NOT_FOUND;
    case 405:
      return ErrorCode.METHOD_NOT_ALLOWED;
    case 409:
      return ErrorCode.CONFLICT;
    case 413:
      return ErrorCode.PAYLOAD_TOO_LARGE;
    case 415:
      return ErrorCode.UNSUPPORTED_MEDIA_TYPE;
    case 429:
      return ErrorCode.RATE_LIMITED;
    case 503:
      return ErrorCode.SERVICE_UNAVAILABLE;
    default:
      return status >= 500 ? ErrorCode.INTERNAL : ErrorCode.BAD_REQUEST;
  }
}
