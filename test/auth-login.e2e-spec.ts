import { hash } from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  collection,
  expectError,
  http,
  login,
  me,
  register,
  uniqueEmail,
} from './support/auth-helpers.js';
import { closeTestApp, createTestApp } from './support/test-app.js';

import type { NestExpressApplication } from '@nestjs/platform-express';

describe('POST /v1/auth/login', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp({ throttling: false });
  });

  afterAll(() => closeTestApp(app));

  it('signs in with the right password (200) and returns a working access token', async () => {
    const { user, password } = await register(app);
    const body = await login(app, user.email, password);
    expect(body.user).toEqual(user);
    expect(body.tokens.tokenType).toBe('Bearer');
    const res = await me(app, body.tokens.accessToken).expect(200);
    expect(res.body).toEqual({ user, activeCouple: null });
  });

  it('matches the email case- and whitespace-insensitively', async () => {
    const email = uniqueEmail('CaseTest');
    const { password } = await register(app, { email });
    await login(app, `  ${email.toUpperCase()}  `, password);
  });

  it('returns the same public error for an unknown email and a wrong password', async () => {
    const { user } = await register(app);
    const unknown = await http(app)
      .post('/v1/auth/login')
      .send({ email: uniqueEmail('nobody'), password: 'whatever-password' })
      .expect(401);
    const wrong = await http(app)
      .post('/v1/auth/login')
      .send({ email: user.email, password: 'wrong-password' })
      .expect(401);

    const strip = (body: { error: Record<string, unknown> }) => ({ ...body.error, requestId: '-' });
    expect(strip(unknown.body)).toEqual(strip(wrong.body));
    expect(unknown.body.error).toEqual({
      code: 'INVALID_CREDENTIALS',
      message: 'Email or password is incorrect.',
      requestId: unknown.headers['x-request-id'],
    });
    expect(Object.keys(unknown.headers).sort()).toEqual(Object.keys(wrong.headers).sort());
  });

  it('creates an independent session per login', async () => {
    const { user, password, tokens } = await register(app);
    const second = await login(app, user.email, password);
    expect(second.tokens.refreshToken.split('.')[0]).not.toBe(tokens.refreshToken.split('.')[0]);
    const internalUser = await collection(app, 'users').findOne({ publicId: user.id });
    expect(
      await collection(app, 'auth_sessions').countDocuments({ userId: internalUser?._id }),
    ).toBe(2);
  });

  it('upgrades a hash made with weaker parameters on successful login', async () => {
    const { user, password } = await register(app);
    const weak = await hash(password, { memoryCost: 8192, timeCost: 1, parallelism: 1 });
    await collection(app, 'users').updateOne(
      { publicId: user.id },
      { $set: { passwordHash: weak } },
    );

    await login(app, user.email, password);
    const stored = await collection(app, 'users').findOne({ publicId: user.id });
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    await login(app, user.email, password);
  });

  it('rejects an account without a password like any other bad login', async () => {
    const { user } = await register(app);
    await collection(app, 'users').updateOne(
      { publicId: user.id },
      { $unset: { passwordHash: '' } },
    );
    const res = await http(app)
      .post('/v1/auth/login')
      .send({ email: user.email, password: 'anything-at-all' })
      .expect(401);
    expectError(res.body, 'INVALID_CREDENTIALS');
  });

  it.each([
    [
      {},
      [
        { field: 'email', code: 'required' },
        { field: 'password', code: 'required' },
      ],
    ],
    [{ email: 'nope', password: 'x' }, [{ field: 'email', code: 'invalidEmail' }]],
    [
      { email: 'a@example.com', password: 'p'.repeat(129) },
      [{ field: 'password', code: 'passwordTooLong' }],
    ],
  ])('validates the body %#', async (body, details) => {
    const res = await http(app).post('/v1/auth/login').send(body).expect(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details });
  });

  it('does not apply the registration minimum length at login', async () => {
    const res = await http(app)
      .post('/v1/auth/login')
      .send({ email: uniqueEmail(), password: 'short' })
      .expect(401);
    expectError(res.body, 'INVALID_CREDENTIALS');
  });
});
