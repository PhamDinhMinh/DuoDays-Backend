import { describe, expect, it } from 'vitest';

import { createPublicId } from '../../../common/ids/public-id.js';
import {
  formatRefreshToken,
  generateRefreshSecret,
  hashesMatch,
  hashRefreshSecret,
  parseRefreshToken,
} from './refresh-token.js';

const PEPPER = 'p'.repeat(43);

describe('refresh token', () => {
  it('generates 32-byte base64url secrets that never repeat', () => {
    const secrets = new Set(Array.from({ length: 5_000 }, generateRefreshSecret));
    expect(secrets.size).toBe(5_000);
    for (const secret of [...secrets].slice(0, 50)) {
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it('round-trips format → parse', () => {
    const sessionId = createPublicId('ses');
    const secret = generateRefreshSecret();
    expect(parseRefreshToken(formatRefreshToken(sessionId, secret))).toEqual({ sessionId, secret });
  });

  it.each([
    '',
    'garbage',
    '.',
    'ses_AAAAAAAAAAAAAAAA.',
    `.${'a'.repeat(43)}`,
    `ses_AAAAAAAAAAAAAAAA.${'a'.repeat(42)}`,
    `ses_AAAAAAAAAAAAAAAA.${'a'.repeat(44)}`,
    `ses_AAAAAAAAAAAAAAAA.${'a'.repeat(42)}=`,
    `usr_AAAAAAAAAAAAAAAA.${'a'.repeat(43)}`,
    `ses_AAAA.${'a'.repeat(43)}`,
    `ses_AAAAAAAAAAAAAAAA.${'a'.repeat(21)}.${'a'.repeat(21)}`,
  ])('rejects %p', token => {
    expect(parseRefreshToken(token)).toBeNull();
  });

  it('hashes with the pepper (HMAC-SHA256, base64url) deterministically', () => {
    const secret = generateRefreshSecret();
    const hashed = hashRefreshSecret(secret, PEPPER);
    expect(hashed).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashed).toBe(hashRefreshSecret(secret, PEPPER));
    expect(hashed).not.toBe(hashRefreshSecret(secret, 'q'.repeat(43)));
    expect(hashed).not.toContain(secret);
  });

  it('compares hashes safely', () => {
    const a = hashRefreshSecret('a'.repeat(43), PEPPER);
    const b = hashRefreshSecret('b'.repeat(43), PEPPER);
    expect(hashesMatch(a, a)).toBe(true);
    expect(hashesMatch(a, b)).toBe(false);
    expect(hashesMatch(undefined, a)).toBe(false);
    expect(hashesMatch(null, a)).toBe(false);
    expect(hashesMatch(a.slice(1), a)).toBe(false);
  });
});
