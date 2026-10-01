import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_PASSWORD, expectError, http, uniqueEmail } from './support/auth-helpers.js';
import { closeTestApp, createTestApp } from './support/test-app.js';

import type { NestExpressApplication } from '@nestjs/platform-express';

/** Route limits are fixed per endpoint (not THROTTLE_LIMIT), so each case gets a fresh app. */
describe('auth endpoint rate limits (per IP, in memory)', () => {
  let app: NestExpressApplication | undefined;

  afterEach(async () => {
    await closeTestApp(app);
    app = undefined;
  });

  async function hitUntilLimited(
    send: () => Promise<{ status: number; body: unknown }>,
    limit: number,
  ) {
    for (let i = 0; i < limit; i += 1) {
      expect((await send()).status).not.toBe(429);
    }
    const blocked = await send();
    expect(blocked.status).toBe(429);
    expectError(blocked.body, 'RATE_LIMITED');
  }

  it('login: 10 per minute', async () => {
    app = await createTestApp();
    const server = app;
    await hitUntilLimited(
      () =>
        http(server)
          .post('/v1/auth/login')
          .send({ email: uniqueEmail(), password: 'wrong-password' }),
      10,
    );
  });

  it('register: 10 per hour', async () => {
    app = await createTestApp();
    const server = app;
    await hitUntilLimited(
      () =>
        http(server)
          .post('/v1/auth/register')
          .send({ displayName: 'R', email: uniqueEmail(), password: DEFAULT_PASSWORD }),
      10,
    );
  });

  it('refresh: 30 per minute', async () => {
    app = await createTestApp();
    const server = app;
    await hitUntilLimited(
      () => http(server).post('/v1/auth/refresh').send({ refreshToken: 'garbage' }),
      30,
    );
  });

  it('logout: 30 per minute', async () => {
    app = await createTestApp();
    const server = app;
    await hitUntilLimited(
      () => http(server).post('/v1/auth/logout').send({ refreshToken: 'garbage' }),
      30,
    );
  });

  it('limits are per route: exhausting login does not block refresh', async () => {
    app = await createTestApp();
    const server = app;
    await hitUntilLimited(
      () =>
        http(server).post('/v1/auth/login').send({ email: uniqueEmail(), password: 'nope-nope' }),
      10,
    );
    expect(
      (await http(server).post('/v1/auth/refresh').send({ refreshToken: 'garbage' })).status,
    ).toBe(401);
  });

  it('throttles before authenticating (unauthenticated floods on /me are limited)', async () => {
    app = await createTestApp({ env: { THROTTLE_LIMIT: '3' } });
    const server = app;
    await hitUntilLimited(() => http(server).get('/v1/auth/me'), 3);
  });
});
