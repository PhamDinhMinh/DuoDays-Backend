import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  collection,
  http,
  login,
  me,
  patchSession,
  refresh,
  register,
  sessionDoc,
  uniqueEmail,
} from './support/auth-helpers.js';
import {
  captureLogs,
  closeTestApp,
  createTestApp,
  TEST_JWT_SECRET,
  TEST_REFRESH_PEPPER,
} from './support/test-app.js';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { LogCapture } from './support/test-app.js';
import type { Tokens } from './support/auth-helpers.js';

describe('auth logging never leaks credentials', () => {
  let app: NestExpressApplication;
  let logs: LogCapture;
  const secrets: string[] = [];
  const events: string[] = [];

  beforeAll(async () => {
    logs = captureLogs();
    // debug: include the most verbose auth events too.
    app = await createTestApp({ env: { LOG_LEVEL: 'debug' }, logs, throttling: false });

    const email = uniqueEmail('Logged.User');
    const password = 'super secret password';
    const registered = await register(app, { email, password });
    const t0 = registered.tokens;

    // Every flow, with the credentials also sent as headers, bodies and bad inputs.
    await http(app).post('/v1/auth/login').send({ email, password: 'wrong password!' }).expect(401);
    await http(app)
      .post('/v1/auth/login')
      .send({ email: uniqueEmail('ghost'), password })
      .expect(401);
    await http(app)
      .post('/v1/auth/register')
      .send({ displayName: 'Dup', email, password })
      .expect(409);
    const loggedIn = await login(app, email, password);
    await me(app, t0.accessToken).expect(200);
    const t1 = ((await refresh(app, t0.refreshToken).expect(200)).body as { tokens: Tokens })
      .tokens;
    await patchSession(app, t1.refreshToken, { lastRotatedAt: new Date(Date.now() - 60_000) });
    await refresh(app, t0.refreshToken).expect(401); // reuse → revoke
    await http(app)
      .post('/v1/auth/logout')
      .send({ refreshToken: loggedIn.tokens.refreshToken })
      .expect(204);
    await http(app)
      .get('/v1/auth/me')
      .set('authorization', `Bearer ${t1.accessToken}x`)
      .expect(401);

    const userDoc = await collection(app, 'users').findOne({ publicId: registered.user.id });
    const sessionAfterReuse = await sessionDoc(app, t1.refreshToken);
    secrets.push(
      password,
      'wrong password!',
      email,
      email.toLowerCase(),
      String(userDoc?.passwordHash),
      t0.accessToken,
      t0.refreshToken,
      t0.refreshToken.split('.')[1],
      t1.accessToken,
      t1.refreshToken.split('.')[1],
      loggedIn.tokens.refreshToken.split('.')[1],
      String(sessionAfterReuse?.tokenHash),
      String(sessionAfterReuse?.previousTokenHash),
      TEST_JWT_SECRET,
      TEST_REFRESH_PEPPER,
      process.env.MONGODB_URI ?? 'mongodb-uri-missing',
    );
    events.push(...logs.lines().map(line => String(line.msg)));
  });

  afterAll(() => closeTestApp(app));

  it('contains none of the passwords, hashes, tokens, secrets, emails or the Mongo URI', () => {
    const raw = logs.raw();
    expect(raw.length).toBeGreaterThan(1000);
    for (const secret of secrets) {
      expect(secret.length).toBeGreaterThan(5);
      expect(raw, `log output leaked: ${secret.slice(0, 6)}…`).not.toContain(secret);
    }
  });

  it('shows Authorization headers only as [REDACTED]', () => {
    const withAuth = logs
      .lines()
      .filter(
        line => (line.req as { headers?: { authorization?: string } })?.headers?.authorization,
      );
    expect(withAuth.length).toBeGreaterThanOrEqual(2);
    for (const line of withAuth) {
      expect((line.req as { headers: { authorization: string } }).headers.authorization).toBe(
        '[REDACTED]',
      );
    }
  });

  it('records the auth events with public ids only', () => {
    expect(events).toEqual(
      expect.arrayContaining([
        'auth.registered',
        'auth.login_failed',
        'auth.login_succeeded',
        'auth.refresh_rotated',
        'auth.refresh_reuse_detected',
        'auth.logout',
      ]),
    );
    const reuse = logs.lines().find(line => line.msg === 'auth.refresh_reuse_detected');
    expect(reuse).toMatchObject({ level: 40, sessionId: expect.stringMatching(/^ses_/) });
    const success = logs.lines().find(line => line.msg === 'auth.login_succeeded');
    expect(success).toMatchObject({
      userId: expect.stringMatching(/^usr_/),
      sessionId: expect.stringMatching(/^ses_/),
    });
    const failed = logs.lines().filter(line => line.msg === 'auth.login_failed');
    expect(failed).toHaveLength(2);
    for (const line of failed) {
      expect(Object.keys(line)).not.toContain('email');
      expect(line).toMatchObject({ reason: 'invalid_credentials' });
    }
  });
});
