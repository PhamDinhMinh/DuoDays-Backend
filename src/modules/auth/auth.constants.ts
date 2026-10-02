/** Mirrors the app's PASSWORD_MIN_LENGTH. */
export const PASSWORD_MIN_LENGTH = 8;
/** Generous for passphrases; bounds Argon2 input. */
export const PASSWORD_MAX_LENGTH = 128;
/** RFC 5321 path limit. */
export const EMAIL_MAX_LENGTH = 254;
/** `ses_` + 16 + `.` + 43 = 64; anything much longer is not ours. */
export const REFRESH_TOKEN_MAX_LENGTH = 256;

/** A previous refresh token presented this soon after rotation is a benign client race. */
export const REFRESH_REUSE_GRACE_MS = 15_000;
/** Expired/revoked sessions are kept this long before the TTL index deletes them. */
export const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Per-IP limits (in-memory throttler, single instance). Override the global default. */
export const AUTH_THROTTLE = {
  register: { default: { limit: 10, ttl: HOUR_MS } },
  login: { default: { limit: 10, ttl: MINUTE_MS } },
  refresh: { default: { limit: 30, ttl: MINUTE_MS } },
  logout: { default: { limit: 30, ttl: MINUTE_MS } },
} as const;
