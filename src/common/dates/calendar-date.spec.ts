import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addYears,
  isCalendarDate,
  isValidRelationshipStartDate,
  relationshipStartDateBounds,
  todayAtUtcOffset,
} from './calendar-date.js';

const at = (iso: string) => Date.parse(iso);

describe('calendar dates', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('really runs in the TZ requested by npm run test:tz', () => {
    // Guards the Hanoi / New York runs against silently becoming duplicate UTC runs.
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (process.env.TZ) {
      // ICU reports some zones by their canonical alias (TZ=Asia/Ho_Chi_Minh resolves to
      // "Asia/Saigon"), so compare canonical names. A silent fallback to UTC still fails.
      const requested = new Intl.DateTimeFormat('en', {
        timeZone: process.env.TZ,
      }).resolvedOptions().timeZone;
      expect(resolved).toBe(requested);
    } else {
      expect(typeof resolved).toBe('string');
    }
  });

  describe('isCalendarDate', () => {
    it.each(['2025-08-28', '2024-02-29', '2000-02-29', '1926-01-01', '0001-01-01', '9999-12-31'])(
      'accepts %s',
      value => {
        expect(isCalendarDate(value)).toBe(true);
      },
    );

    it.each([
      '2025-02-29',
      '1900-02-29',
      '2025-02-30',
      '2025-04-31',
      '2025-13-01',
      '2025-00-10',
      '2025-01-00',
      '0000-01-01',
      '2025-8-28',
      '25-08-28',
      '2025/08/28',
      '2025-08-28T00:00:00Z',
      ' 2025-08-28',
      '',
      20250828,
      null,
      new Date(),
    ])('rejects %p', value => {
      expect(isCalendarDate(value)).toBe(false);
    });
  });

  describe('addYears', () => {
    it('moves Feb 29 to Feb 28 in a non-leap year (like date-fns)', () => {
      expect(addYears('2024-02-29', -100)).toBe('1924-02-29');
      expect(addYears('2024-02-29', -1)).toBe('2023-02-28');
      expect(addYears('2026-10-01', -100)).toBe('1926-10-01');
    });
  });

  describe('todayAtUtcOffset', () => {
    it('depends only on the instant and the offset – never on the server TZ', () => {
      const instant = at('2026-10-01T17:30:00Z');
      expect(todayAtUtcOffset(0, instant)).toBe('2026-10-01');
      expect(todayAtUtcOffset(7, instant)).toBe('2026-10-02'); // Hanoi
      expect(todayAtUtcOffset(-4, instant)).toBe('2026-10-01'); // New York (EDT)
      expect(todayAtUtcOffset(14, instant)).toBe('2026-10-02');
      expect(todayAtUtcOffset(-12, instant)).toBe('2026-10-01');
    });

    it('handles year boundaries', () => {
      const instant = at('2026-12-31T11:00:00Z');
      expect(todayAtUtcOffset(14, instant)).toBe('2027-01-01');
      expect(todayAtUtcOffset(-12, instant)).toBe('2026-12-30');
    });
  });

  describe('relationship start date bounds (UTC+14 / UTC−12)', () => {
    it('allows the latest local "today" anywhere and the app\'s 100-year floor everywhere', () => {
      expect(relationshipStartDateBounds(at('2026-10-01T17:30:00Z'))).toEqual({
        min: '1926-10-01', // UTC−12 is at Oct 1 05:30
        max: '2026-10-02', // UTC+14 is already at Oct 2 07:30
      });
      expect(relationshipStartDateBounds(at('2026-10-01T06:00:00Z'))).toEqual({
        min: '1926-09-30', // UTC−12 is still on Sep 30
        max: '2026-10-01',
      });
    });

    it("accepts a Hanoi user's local today while UTC is still on yesterday", () => {
      // 2026-10-01T17:30Z = 2026-10-02 00:30 in Hanoi.
      const instant = at('2026-10-01T17:30:00Z');
      expect(isValidRelationshipStartDate('2026-10-02', instant)).toBe(true);
      expect(isValidRelationshipStartDate('2026-10-03', instant)).toBe(false);
    });

    it("accepts a New York user's local today late in their evening", () => {
      // 2026-10-02T03:30Z = 2026-10-01 23:30 in New York.
      const instant = at('2026-10-02T03:30:00Z');
      expect(isValidRelationshipStartDate('2026-10-01', instant)).toBe(true);
      expect(isValidRelationshipStartDate('2026-10-02', instant)).toBe(true);
    });

    it('rejects dates beyond the widest possible "today" and before the 100-year floor', () => {
      const instant = at('2026-10-01T00:00:00Z');
      const { min, max } = relationshipStartDateBounds(instant);
      expect(isValidRelationshipStartDate(max, instant)).toBe(true);
      expect(isValidRelationshipStartDate(min, instant)).toBe(true);
      expect(isValidRelationshipStartDate('2026-10-02', instant)).toBe(false); // > max (Oct 1 +14h)
      expect(isValidRelationshipStartDate('1926-09-29', instant)).toBe(false); // < min
    });

    it('uses the real clock by default', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-01T17:30:00Z'));
      expect(relationshipStartDateBounds().max).toBe('2026-10-02');
    });

    it('rejects non-dates', () => {
      expect(isValidRelationshipStartDate('2025-02-30')).toBe(false);
      expect(isValidRelationshipStartDate(undefined)).toBe(false);
    });
  });
});
