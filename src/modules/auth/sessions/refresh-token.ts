import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { isPublicId } from '../../../common/ids/public-id.js';

/*
 * Refresh token = `<session publicId>.<secret>`, e.g. `ses_3fK9aZq0LmN2pQ7x.Qm9v…`.
 * - secret: 32 random bytes, base64url (43 chars). Only the client ever holds it.
 * - stored: HMAC-SHA256(key = REFRESH_TOKEN_PEPPER, secret). A database leak alone cannot
 *   produce a usable token, and lookups need no hash index (the session id is in the token).
 */

const SECRET_BYTES = 32;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface ParsedRefreshToken {
  sessionId: string;
  secret: string;
}

export function generateRefreshSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

export function formatRefreshToken(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`;
}

/** Null for anything that is not structurally one of our tokens. */
export function parseRefreshToken(token: string): ParsedRefreshToken | null {
  const dot = token.indexOf('.');
  if (dot === -1) {
    return null;
  }
  const sessionId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!isPublicId(sessionId, 'ses') || !SECRET_PATTERN.test(secret)) {
    return null;
  }
  return { sessionId, secret };
}

export function hashRefreshSecret(secret: string, pepper: string): string {
  return createHmac('sha256', pepper).update(secret).digest('base64url');
}

/** Constant-time comparison of two hashes (false for missing/mismatched lengths). */
export function hashesMatch(a: string | null | undefined, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
