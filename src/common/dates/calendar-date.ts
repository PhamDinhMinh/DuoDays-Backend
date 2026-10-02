/*
 * Calendar dates ("wall calendar" days such as a relationship start date) are `YYYY-MM-DD`
 * strings end-to-end: request → MongoDB → response. Aug 28 is Aug 28 for both partners
 * wherever they are, so these values are never turned into a JS `Date` or BSON Date –
 * that is exactly how off-by-one-day bugs appear. Zero-padded strings sort chronologically,
 * so plain string comparison is correct.
 *
 * All calendar-date rules live in this file. Do not re-implement them elsewhere.
 */

export type CalendarDate = string;

const PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const HOUR_MS = 60 * 60 * 1000;

interface CalendarDateParts {
  year: number;
  month: number;
  day: number;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function parse(value: string): CalendarDateParts | null {
  const match = PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  return { year, month, day };
}

function format({ year, month, day }: CalendarDateParts): CalendarDate {
  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-');
}

/** A real `YYYY-MM-DD` day (no Feb 30, leap years respected). */
export function isCalendarDate(value: unknown): value is CalendarDate {
  return typeof value === 'string' && parse(value) !== null;
}

/**
 * Adds whole years; Feb 29 lands on Feb 28 in a non-leap year (same as the app's
 * date-fns `addYears`).
 */
export function addYears(value: CalendarDate, years: number): CalendarDate {
  const parts = parse(value);
  if (!parts) {
    throw new RangeError('addYears expects a valid calendar date');
  }
  const year = parts.year + years;
  return format({
    year,
    month: parts.month,
    day: Math.min(parts.day, daysInMonth(year, parts.month)),
  });
}

/**
 * Today's date on the wall calendar of a fixed UTC offset. Uses only UTC getters, so the
 * server's own timezone (TZ) can never influence the result.
 */
export function todayAtUtcOffset(offsetHours: number, nowMs: number = Date.now()): CalendarDate {
  const shifted = new Date(nowMs + offsetHours * HOUR_MS);
  return format({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
}

/*
 * Relationship start date rule (product decision): not in the future and at most 100 years
 * ago – both judged on the USER's local calendar, which the server does not know.
 *
 * At any instant, the calendar dates in use around the world range from "today" in the
 * furthest-ahead zone (UTC+14, Line Islands) to "today" in the furthest-behind zone
 * (UTC−12, Baker Island). The server therefore accepts the widest window any real device
 * could legitimately produce:
 *   max = today at UTC+14        – a user in Hanoi or New York picking their own "today"
 *                                  is never rejected, even when UTC is still on yesterday;
 *   min = today at UTC−12 − 100y – never stricter than the app's own 100-year limit.
 * The app's per-device check is stricter; this server check is the authoritative outer bound.
 */
export const LATEST_UTC_OFFSET_HOURS = 14;
export const EARLIEST_UTC_OFFSET_HOURS = -12;
export const RELATIONSHIP_START_MAX_YEARS_AGO = 100;

export interface CalendarDateBounds {
  min: CalendarDate;
  max: CalendarDate;
}

export function relationshipStartDateBounds(nowMs: number = Date.now()): CalendarDateBounds {
  return {
    min: addYears(
      todayAtUtcOffset(EARLIEST_UTC_OFFSET_HOURS, nowMs),
      -RELATIONSHIP_START_MAX_YEARS_AGO,
    ),
    max: todayAtUtcOffset(LATEST_UTC_OFFSET_HOURS, nowMs),
  };
}

export function isValidRelationshipStartDate(value: unknown, nowMs: number = Date.now()): boolean {
  if (!isCalendarDate(value)) {
    return false;
  }
  const { min, max } = relationshipStartDateBounds(nowMs);
  return value >= min && value <= max;
}
