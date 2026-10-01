import { randomBytes } from 'node:crypto';

/*
 * Public identifiers are what the API exposes instead of MongoDB ObjectIds:
 * `<prefix>_<16 base62 chars>` (~95 bits of randomness), e.g. `cpl_3fK9aZq0LmN2pQ7x`.
 * They are opaque, unguessable and reveal neither creation time nor record counts.
 * Every collection that exposes documents stores one under a unique `publicId` index.
 */

export const PublicIdPrefix = {
  user: 'usr',
  couple: 'cpl',
  session: 'ses',
} as const;

export type PublicIdPrefix = (typeof PublicIdPrefix)[keyof typeof PublicIdPrefix];

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BODY_LENGTH = 16;
/** Largest multiple of 62 below 256 – bytes at or above it are rejected to avoid bias. */
const UNBIASED_LIMIT = 256 - (256 % ALPHABET.length);
const BODY_PATTERN = new RegExp(`^[0-9A-Za-z]{${BODY_LENGTH}}$`);

export function createPublicId(prefix: PublicIdPrefix): string {
  let body = '';
  while (body.length < BODY_LENGTH) {
    for (const byte of randomBytes(BODY_LENGTH * 2)) {
      if (byte < UNBIASED_LIMIT) {
        body += ALPHABET[byte % ALPHABET.length];
        if (body.length === BODY_LENGTH) {
          break;
        }
      }
    }
  }
  return `${prefix}_${body}`;
}

export function isPublicId(value: unknown, prefix: PublicIdPrefix): value is string {
  if (typeof value !== 'string' || !value.startsWith(`${prefix}_`)) {
    return false;
  }
  return BODY_PATTERN.test(value.slice(prefix.length + 1));
}
