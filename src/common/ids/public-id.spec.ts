import { describe, expect, it } from 'vitest';

import { createPublicId, isPublicId, PublicIdPrefix } from './public-id.js';

describe('createPublicId', () => {
  it.each(Object.values(PublicIdPrefix))('formats %s ids as <prefix>_<16 base62>', prefix => {
    expect(createPublicId(prefix)).toMatch(new RegExp(`^${prefix}_[0-9A-Za-z]{16}$`));
  });

  it('does not repeat across many ids', () => {
    const ids = new Set(Array.from({ length: 20_000 }, () => createPublicId('cpl')));
    expect(ids.size).toBe(20_000);
  });

  it('uses the whole alphabet roughly evenly', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 5_000; i += 1) {
      for (const char of createPublicId('usr').slice(4)) {
        counts.set(char, (counts.get(char) ?? 0) + 1);
      }
    }
    // 80,000 chars / 62 symbols ≈ 1,290 each.
    expect(counts.size).toBe(62);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(1_000);
      expect(count).toBeLessThan(1_600);
    }
  });
});

describe('isPublicId', () => {
  it('accepts a generated id for its own prefix only', () => {
    const id = createPublicId('cpl');
    expect(isPublicId(id, 'cpl')).toBe(true);
    expect(isPublicId(id, 'usr')).toBe(false);
  });

  it.each([
    'cpl_short',
    'cpl_0123456789abcdefX',
    'cpl_0123456789abcde!',
    'cpl-0123456789abcdef',
    '507f1f77bcf86cd799439011',
    '',
  ])('rejects %p', value => {
    expect(isPublicId(value, 'cpl')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isPublicId(42, 'cpl')).toBe(false);
    expect(isPublicId({ $ne: null }, 'cpl')).toBe(false);
  });
});
