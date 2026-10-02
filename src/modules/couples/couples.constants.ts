const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * How long an invite stays in the database after it stops being usable (expiry, revocation
 * or redemption). Keeps "expired"/"already used" answers and join retries accurate for a
 * while and keeps the code reserved; after that the TTL index deletes it.
 */
export const INVITE_RETENTION_MS = 24 * HOUR_MS;

/** Fresh codes tried when the unique code index reports a collision. */
export const INVITE_CODE_ATTEMPTS = 5;

/** Per-IP limits (global throttler) for couple-setup routes without a user bucket. */
export const COUPLE_THROTTLE = {
  cancel: { default: { limit: 10, ttl: MINUTE_MS } },
} as const;

/**
 * Per-user AND per-IP buckets enforced by UserRateLimitGuard. Routes naming the same bucket
 * share one budget: a join with a guessed code is a guess just like a lookup.
 *
 * inviteCode – 6-digit codes are brute-forceable; at most 20 guesses an hour per account
 *   and per IP (≈480/day). With N usable invites a guess hits with probability N/900,000.
 * inviteIssue – every new invite reserves a code for ~TTL + retention, so issuing is capped
 *   to keep the code space from being drained.
 */
export const INVITE_RATE_LIMITS = {
  inviteCode: [
    { limit: 10, ttlMs: MINUTE_MS },
    { limit: 20, ttlMs: HOUR_MS },
  ],
  inviteIssue: [
    { limit: 10, ttlMs: MINUTE_MS },
    { limit: 30, ttlMs: HOUR_MS },
  ],
} as const;
