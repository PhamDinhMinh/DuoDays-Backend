import { describe, expect, it } from 'vitest';

import { extractBearerToken } from './jwt-auth.guard.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';

describe('extractBearerToken', () => {
  it.each([`Bearer ${JWT}`, `bearer ${JWT}`, `BEARER ${JWT}`])('accepts %p', header => {
    expect(extractBearerToken(header)).toBe(JWT);
  });

  it.each([
    undefined,
    '',
    JWT,
    `Basic ${JWT}`,
    `Bearer  ${JWT}`,
    `Bearer ${JWT} `,
    `Bearer ${JWT}.extra`,
    'Bearer a.b',
    'Bearer a.b.',
    `Bearer ${JWT},${JWT}`,
    ['Bearer', JWT],
  ])('rejects %p', header => {
    expect(extractBearerToken(header)).toBeNull();
  });
});
