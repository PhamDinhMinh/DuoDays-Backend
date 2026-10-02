import { describe, expect, it } from 'vitest';

import {
  INVITE_CODE_MAX_EXCLUSIVE,
  INVITE_CODE_MIN,
  INVITE_CODE_PATTERN,
  InviteCodeGenerator,
} from './invite-code.generator.js';

describe('InviteCodeGenerator', () => {
  const generator = new InviteCodeGenerator();

  it('produces six-digit strings in 100000–999999', () => {
    for (let i = 0; i < 2000; i += 1) {
      const code = generator.next();
      expect(code).toMatch(INVITE_CODE_PATTERN);
      expect(Number(code)).toBeGreaterThanOrEqual(INVITE_CODE_MIN);
      expect(Number(code)).toBeLessThan(INVITE_CODE_MAX_EXCLUSIVE);
    }
  });

  it('is not sequential or constant', () => {
    const codes = Array.from({ length: 200 }, () => generator.next());
    expect(new Set(codes).size).toBeGreaterThan(190);
    const steps = new Set(codes.slice(1).map((code, i) => Number(code) - Number(codes[i])));
    expect(steps.size).toBeGreaterThan(190);
  });
});

describe('INVITE_CODE_PATTERN', () => {
  it.each(['123456', '012345'])('accepts %s', code => {
    expect(INVITE_CODE_PATTERN.test(code)).toBe(true);
  });

  it.each(['12345', '1234567', '12345a', ' 123456', '123 456', '１２３４５６'])(
    'rejects %p',
    code => {
      expect(INVITE_CODE_PATTERN.test(code)).toBe(false);
    },
  );
});
