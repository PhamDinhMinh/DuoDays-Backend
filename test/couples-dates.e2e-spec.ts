import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addYears, relationshipStartDateBounds } from '../src/common/dates/calendar-date.js';
import {
  createCouple,
  getCouple,
  patchCouple,
  raw,
  signedInUser,
  userWithCouple,
  VALID_COUPLE,
} from './support/couple-helpers.js';
import { closeTestApp, createTestApp } from './support/test-app.js';

import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Run under several TZ values by `npm run test:tz` (Asia/Ho_Chi_Minh, America/New_York):
 * the start date must come back byte-for-byte whatever the server's timezone.
 */
describe(`relationship start dates (TZ=${process.env.TZ ?? 'default'})`, () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp({ throttling: false });
  });

  afterAll(() => closeTestApp(app));

  it('really runs in the TZ requested by npm run test:tz', () => {
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

  it.each(['2025-08-28', '2024-02-29', '2000-01-01', '2025-12-31', '2026-01-01'])(
    'round-trips %s unchanged through API and MongoDB as a string',
    async startDate => {
      const { token, couple } = await userWithCouple(app, { ...VALID_COUPLE, startDate });
      expect(couple.startDate).toBe(startDate);
      expect((await getCouple(app, token, couple.id).expect(200)).body.startDate).toBe(startDate);

      const stored = await raw(app, 'couples').findOne({ publicId: couple.id });
      expect(stored?.startDate).toBe(startDate);
      expect(typeof stored?.startDate).toBe('string');
    },
  );

  it('keeps the date exact through an update', async () => {
    const { token, couple } = await userWithCouple(app);
    const res = await patchCouple(app, token, couple.id, { startDate: '2023-03-26' }).expect(200);
    expect(res.body.startDate).toBe('2023-03-26');
    expect((await raw(app, 'couples').findOne({ publicId: couple.id }))?.startDate).toBe(
      '2023-03-26',
    );
  });

  it('accepts the globally-latest "today" and the 100-year floor; rejects one day beyond each', async () => {
    const { min, max } = relationshipStartDateBounds();
    const dayAfter = (date: string) => {
      const next = new Date(`${date}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      return next.toISOString().slice(0, 10);
    };
    const dayBefore = (date: string) => {
      const prev = new Date(`${date}T00:00:00Z`);
      prev.setUTCDate(prev.getUTCDate() - 1);
      return prev.toISOString().slice(0, 10);
    };

    for (const ok of [max, min]) {
      await userWithCouple(app, { ...VALID_COUPLE, startDate: ok });
    }
    for (const bad of [dayAfter(max), dayBefore(min)]) {
      const { token } = await signedInUser(app);
      const res = await createCouple(app, token, { ...VALID_COUPLE, startDate: bad }).expect(400);
      expect(res.body.error.details).toEqual([{ field: 'startDate', code: 'invalidDate' }]);
    }
    expect(addYears(max, -100) >= min).toBe(true);
  });
});
