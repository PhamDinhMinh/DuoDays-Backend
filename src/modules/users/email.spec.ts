import { describe, expect, it } from 'vitest';

import { normalizeEmail } from './email.js';

describe('normalizeEmail', () => {
  it.each([
    ['minh@example.com', 'minh@example.com'],
    ['  Minh@Example.COM  ', 'minh@example.com'],
    ['\tLINH@EXAMPLE.COM\n', 'linh@example.com'],
  ])('%p → %p', (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });

  it('keeps provider-specific characters (dots, +tags) intact', () => {
    expect(normalizeEmail('First.Last+Tag@Gmail.com')).toBe('first.last+tag@gmail.com');
  });
});
