import { afterEach, describe, expect, it } from 'vitest';

import { expectError } from './support/auth-helpers.js';
import { signedInUser, userWithCouple } from './support/couple-helpers.js';
import {
  cancelCouple,
  ensureInvite,
  joinInvite,
  lookupInvite,
  regenerateInvite,
} from './support/invite-helpers.js';
import { closeTestApp, createTestApp } from './support/test-app.js';

import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Couple-setup rate limits (in memory). All requests come from 127.0.0.1, so the per-IP and
 * per-user budgets coincide here; the guard's unit spec separates them.
 */
describe('couple-setup rate limits', () => {
  let app: NestExpressApplication | undefined;

  afterEach(async () => {
    await closeTestApp(app);
    app = undefined;
  });

  function expectLimited(res: { status: number; body: unknown; headers: Record<string, string> }) {
    expect(res.status).toBe(429);
    expectError(res.body, 'RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  }

  it('lookup and join share 10 code guesses per minute (brute-force guard)', async () => {
    app = await createTestApp();
    const server = app;
    const guesser = await signedInUser(server);
    for (let i = 0; i < 5; i += 1) {
      expect((await lookupInvite(server, guesser.token, String(200_000 + i))).status).toBe(404);
      expect((await joinInvite(server, guesser.token, String(300_000 + i))).status).toBe(404);
    }
    expectLimited(await lookupInvite(server, guesser.token, '200099'));
    expectLimited(await joinInvite(server, guesser.token, '300099'));
  });

  it('a second account on the same IP does not get a fresh budget', async () => {
    app = await createTestApp();
    const server = app;
    const [a, b] = [await signedInUser(server), await signedInUser(server)];
    for (let i = 0; i < 10; i += 1) {
      await lookupInvite(server, a.token, String(400_000 + i)).expect(404);
    }
    expectLimited(await lookupInvite(server, b.token, '400099'));
  });

  it('issuing invites: 10 per minute', async () => {
    app = await createTestApp();
    const server = app;
    const { token, couple } = await userWithCouple(server);
    for (let i = 0; i < 10; i += 1) {
      await ensureInvite(server, token, couple.id).expect(200);
    }
    expectLimited(await ensureInvite(server, token, couple.id));
  });

  it('ensure and regenerate share the issue budget (controller wiring)', async () => {
    app = await createTestApp();
    const server = app;
    const { token, couple } = await userWithCouple(server);
    for (let i = 0; i < 5; i += 1) {
      await ensureInvite(server, token, couple.id).expect(200);
      await regenerateInvite(server, token, couple.id).expect(200);
    }
    // 10 issue requests in total: both routes are now out of budget, not 5 + 5 left.
    expectLimited(await regenerateInvite(server, token, couple.id));
    expectLimited(await ensureInvite(server, token, couple.id));
  });

  it('malformed lookup/join bodies spend the code budget before DTO validation', async () => {
    app = await createTestApp();
    const server = app;
    const guesser = await signedInUser(server);
    for (const code of ['abc', '12345', null, 123456, '']) {
      await lookupInvite(server, guesser.token, code).expect(400);
      await joinInvite(server, guesser.token, code).expect(400);
    }
    // The guard runs before the ValidationPipe: still 429, whether well-formed or not.
    expectLimited(await lookupInvite(server, guesser.token, '200001'));
    expectLimited(await joinInvite(server, guesser.token, '200002'));
    expectLimited(await lookupInvite(server, guesser.token, 'abc'));
  });

  it('cancel: 10 per minute per IP', async () => {
    app = await createTestApp();
    const server = app;
    const user = await signedInUser(server);
    for (let i = 0; i < 10; i += 1) {
      await cancelCouple(server, user.token, 'cpl_AAAAAAAAAAAAAAAA').expect(404);
    }
    expectLimited(await cancelCouple(server, user.token, 'cpl_AAAAAAAAAAAAAAAA'));
  });
});
