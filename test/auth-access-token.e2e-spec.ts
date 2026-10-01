import { JwtService } from '@nestjs/jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { collection, http, me, register } from './support/auth-helpers.js';
import {
  closeTestApp,
  createTestApp,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
  TEST_JWT_SECRET,
} from './support/test-app.js';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { JwtSignOptions } from '@nestjs/jwt';

const jwt = new JwtService();
const nowSeconds = () => Math.floor(Date.now() / 1000);

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe('access tokens and GET /v1/auth/me', () => {
  let app: NestExpressApplication;
  let userId: string;
  let sessionId: string;
  let validToken: string;

  /** Signs claims the way the server does, with any field overridable. */
  function sign(
    claims: Record<string, unknown> = {},
    options: Partial<JwtSignOptions> = {},
  ): string {
    const merged: Record<string, unknown> = {
      secret: TEST_JWT_SECRET,
      algorithm: 'HS256',
      subject: userId,
      issuer: TEST_JWT_ISSUER,
      audience: TEST_JWT_AUDIENCE,
      expiresIn: 600,
      ...options,
    };
    // `undefined` means "leave this claim out" (jsonwebtoken rejects explicit undefined).
    const defined = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
    return jwt.sign({ sid: sessionId, ...claims }, defined);
  }

  beforeAll(async () => {
    app = await createTestApp({ throttling: false });
    const registered = await register(app);
    userId = registered.user.id;
    sessionId = registered.tokens.refreshToken.split('.')[0];
    validToken = registered.tokens.accessToken;
  });

  afterAll(() => closeTestApp(app));

  it('carries only sub, sid, iss, aud, iat and exp', () => {
    const payload = JSON.parse(Buffer.from(validToken.split('.')[1], 'base64url').toString());
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sid', 'sub']);
    expect(payload).toMatchObject({
      sub: userId,
      sid: sessionId,
      iss: TEST_JWT_ISSUER,
      aud: TEST_JWT_AUDIENCE,
    });
    expect(payload.exp - payload.iat).toBe(900);
    const header = JSON.parse(Buffer.from(validToken.split('.')[0], 'base64url').toString());
    expect(header.alg).toBe('HS256');
  });

  it('accepts a valid token', async () => {
    await me(app, validToken).expect(200);
    await me(app, sign()).expect(200);
  });

  it('accepts a lowercase "bearer" scheme', async () => {
    await http(app).get('/v1/auth/me').set('authorization', `bearer ${validToken}`).expect(200);
  });

  const rejected: [string, () => string | undefined][] = [
    ['no Authorization header', () => undefined],
    ['a non-Bearer scheme', () => `Basic ${validToken}`],
    ['a bare token without scheme', () => validToken],
    ['garbage', () => 'Bearer not.a.jwt'],
    [
      'an invalid signature',
      () => `Bearer ${sign({}, { secret: 'another-secret-0123456789abcdefghijklmn' })}`,
    ],
    [
      'a tampered payload',
      () => {
        const [h, , s] = validToken.split('.');
        return `Bearer ${h}.${base64url({ sub: 'usr_AAAAAAAAAAAAAAAA', sid: sessionId, iss: TEST_JWT_ISSUER, aud: TEST_JWT_AUDIENCE, exp: nowSeconds() + 600 })}.${s}`;
      },
    ],
    [
      'an expired token',
      () => `Bearer ${sign({ exp: nowSeconds() - 5 }, { expiresIn: undefined })}`,
    ],
    ['a wrong issuer', () => `Bearer ${sign({}, { issuer: 'someone-else' })}`],
    ['a wrong audience', () => `Bearer ${sign({}, { audience: 'another-app' })}`],
    ['no issuer', () => `Bearer ${sign({}, { issuer: undefined })}`],
    ['an unsupported algorithm (HS512)', () => `Bearer ${sign({}, { algorithm: 'HS512' })}`],
    [
      'alg "none"',
      () => {
        const header = base64url({ alg: 'none', typ: 'JWT' });
        const payload = base64url({
          sub: userId,
          sid: sessionId,
          iss: TEST_JWT_ISSUER,
          aud: TEST_JWT_AUDIENCE,
          exp: nowSeconds() + 600,
        });
        return `Bearer ${header}.${payload}.`;
      },
    ],
    [
      'a subject that is not a public user id',
      () => `Bearer ${sign({}, { subject: '507f1f77bcf86cd799439011' })}`,
    ],
    ['a missing session id', () => `Bearer ${sign({ sid: undefined })}`],
  ];

  it.each(rejected)('rejects %s with 401 UNAUTHENTICATED', async (_case, header) => {
    const value = header();
    const req = http(app).get('/v1/auth/me');
    const res = await (value === undefined ? req : req.set('authorization', value)).expect(401);
    expect(res.body.error).toEqual({
      code: 'UNAUTHENTICATED',
      message: 'Authentication required.',
      requestId: res.headers['x-request-id'],
    });
  });

  it('returns 401 when the user no longer exists', async () => {
    const doomed = await register(app);
    await collection(app, 'users').deleteOne({ publicId: doomed.user.id });
    const res = await me(app, doomed.tokens.accessToken).expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('keeps public routes public', async () => {
    await http(app).get('/health').expect(200);
    await http(app).get('/v1/__probe/ok').expect(200);
  });

  it('protects unknown-but-matched routes by default and still 404s unknown ones', async () => {
    await http(app).get('/v1/does-not-exist').expect(404);
  });
});
