import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  collection,
  DEFAULT_PASSWORD,
  expectError,
  http,
  login,
  register,
  uniqueEmail,
} from './support/auth-helpers.js';
import { closeTestApp, createTestApp } from './support/test-app.js';

import type { NestExpressApplication } from '@nestjs/platform-express';

describe('POST /v1/auth/register', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp({ throttling: false });
  });

  afterAll(() => closeTestApp(app));

  it('creates the account and signs in (201)', async () => {
    const email = uniqueEmail('Minh.Tran');
    const res = await http(app)
      .post('/v1/auth/register')
      .send({ displayName: '  Minh  ', email: `  ${email}  `, password: DEFAULT_PASSWORD })
      .expect(201);

    expect(res.body).toEqual({
      user: {
        id: expect.stringMatching(/^usr_[0-9A-Za-z]{16}$/),
        email,
        displayName: 'Minh',
        createdAt: expect.any(String),
      },
      tokens: {
        tokenType: 'Bearer',
        accessToken: expect.stringMatching(/^[\w-]+\.[\w-]+\.[\w-]+$/),
        accessTokenExpiresIn: 900,
        refreshToken: expect.stringMatching(/^ses_[0-9A-Za-z]{16}\.[\w-]{43}$/),
        refreshTokenExpiresAt: expect.any(String),
      },
    });
  });

  it('never returns internal ids or the password (hash)', async () => {
    const { password, ...body } = await register(app);
    const json = JSON.stringify(body);
    for (const leaked of ['_id', 'passwordHash', '$argon2', password, '__v']) {
      expect(json).not.toContain(leaked);
    }
  });

  it('stores an Argon2id hash with the approved parameters – never the plaintext', async () => {
    const { user, password } = await register(app);
    const stored = await collection(app, 'users').findOne({ publicId: user.id });
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(JSON.stringify(stored)).not.toContain(password);
  });

  it('stores the email as entered (trimmed) and a lowercased lookup key', async () => {
    const email = uniqueEmail('MiXeD.Case');
    const { user } = await register(app, { email: ` ${email} ` });
    const stored = await collection(app, 'users').findOne({ publicId: user.id });
    expect(stored).toMatchObject({ email, emailNormalized: email.toLowerCase() });
  });

  it('rejects an email that differs only by case or surrounding spaces (409)', async () => {
    const email = uniqueEmail('Taken');
    await register(app, { email });
    const res = await http(app)
      .post('/v1/auth/register')
      .send({
        displayName: 'Other',
        email: `  ${email.toUpperCase()} `,
        password: DEFAULT_PASSWORD,
      })
      .expect(409);
    expect(res.body.error).toEqual({
      code: 'EMAIL_ALREADY_EXISTS',
      message: 'An account with this email already exists.',
      requestId: res.headers['x-request-id'],
    });
  });

  it('lets exactly one of five parallel registrations for the same normalized email win', async () => {
    const email = uniqueEmail('race');
    const variants = [email, email.toUpperCase(), ` ${email}`, `${email} `, email];
    const responses = await Promise.all(
      variants.map(variant =>
        http(app)
          .post('/v1/auth/register')
          .send({ displayName: 'Racer', email: variant, password: DEFAULT_PASSWORD }),
      ),
    );
    const statuses = responses.map(res => res.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
    for (const res of responses.filter(r => r.status === 409)) {
      expectError(res.body, 'EMAIL_ALREADY_EXISTS');
    }
    expect(
      await collection(app, 'users').countDocuments({ emailNormalized: email.toLowerCase() }),
    ).toBe(1);
  });

  it('preserves password whitespace exactly', async () => {
    const password = '  pass word  ';
    const { user } = await register(app, { password });
    await login(app, user.email, password);
    for (const variant of ['pass word', '  pass word', 'pass word  ', '  password  ']) {
      const res = await http(app)
        .post('/v1/auth/login')
        .send({ email: user.email, password: variant });
      expect(res.status).toBe(401);
    }
  });

  it('does not Unicode-normalize passwords', async () => {
    const composed = 'mật khẩu 123'.normalize('NFC');
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);
    const { user } = await register(app, { password: composed });
    await login(app, user.email, composed);
    const res = await http(app)
      .post('/v1/auth/login')
      .send({ email: user.email, password: decomposed });
    expect(res.status).toBe(401);
  });

  it('counts password and name length like the app (UTF-16 units)', async () => {
    // 4 emoji = 8 UTF-16 code units: valid in the app, so valid here.
    await register(app, { password: '😀😀😀😀' });
    const res = await http(app)
      .post('/v1/auth/register')
      .send({ displayName: '😀'.repeat(26), email: uniqueEmail(), password: DEFAULT_PASSWORD })
      .expect(400);
    expect(res.body.error.details).toEqual([{ field: 'displayName', code: 'nameTooLong' }]);
  });

  describe('validation', () => {
    const valid = () => ({ displayName: 'Linh', email: uniqueEmail(), password: DEFAULT_PASSWORD });

    it.each([
      [
        'missing everything',
        {},
        [
          { field: 'displayName', code: 'required' },
          { field: 'email', code: 'required' },
          { field: 'password', code: 'required' },
        ],
      ],
      [
        'blank name after trim',
        { displayName: '   ' },
        [{ field: 'displayName', code: 'required' }],
      ],
      [
        '51-char name',
        { displayName: 'x'.repeat(51) },
        [{ field: 'displayName', code: 'nameTooLong' }],
      ],
      [
        'control chars in name',
        { displayName: 'Mi\nnh' },
        [{ field: 'displayName', code: 'invalid' }],
      ],
      ['bad email', { email: 'not-an-email' }, [{ field: 'email', code: 'invalidEmail' }]],
      [
        'email without TLD',
        { email: 'minh@localhost' },
        [{ field: 'email', code: 'invalidEmail' }],
      ],
      [
        '7-char password',
        { password: '1234567' },
        [{ field: 'password', code: 'passwordTooShort' }],
      ],
      [
        '129-char password',
        { password: 'p'.repeat(129) },
        [{ field: 'password', code: 'passwordTooLong' }],
      ],
      ['empty password', { password: '' }, [{ field: 'password', code: 'required' }]],
      ['non-string password', { password: 12345678 }, [{ field: 'password', code: 'invalid' }]],
      ['unknown field', { role: 'admin' }, [{ field: 'role', code: 'unknownField' }]],
    ])('%s → 400 VALIDATION_FAILED', async (_case, patch, details) => {
      const body = Object.keys(patch).length === 0 ? {} : { ...valid(), ...patch };
      const res = await http(app).post('/v1/auth/register').send(body).expect(400);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details });
    });

    it('accepts exactly 8 and exactly 128 characters, and an all-space password', async () => {
      await register(app, { password: '12345678' });
      await register(app, { password: 'p'.repeat(128) });
      await register(app, { password: ' '.repeat(8) });
    });
  });
});
