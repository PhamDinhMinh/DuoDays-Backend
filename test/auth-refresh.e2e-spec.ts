import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  collection,
  expectError,
  http,
  login,
  me,
  patchSession,
  refresh,
  register,
  sessionDoc,
  sessionIdOf,
} from './support/auth-helpers.js';
import { closeTestApp, createTestApp, TEST_REFRESH_PEPPER } from './support/test-app.js';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Tokens } from './support/auth-helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const secondsAgo = (s: number) => new Date(Date.now() - s * 1000);

describe('refresh-token lifecycle', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp({ throttling: false });
  });

  afterAll(() => closeTestApp(app));

  async function rotate(refreshToken: string): Promise<Tokens> {
    const res = await refresh(app, refreshToken).expect(200);
    return (res.body as { tokens: Tokens }).tokens;
  }

  describe('storage', () => {
    it('stores only an HMAC of the secret – never the token, never the access token', async () => {
      const { tokens } = await register(app);
      const doc = await sessionDoc(app, tokens.refreshToken);
      const secret = tokens.refreshToken.split('.')[1];
      const json = JSON.stringify(doc);
      expect(json).not.toContain(secret);
      expect(json).not.toContain(tokens.accessToken);
      expect(json).not.toContain(TEST_REFRESH_PEPPER);
      expect(doc).toMatchObject({
        publicId: sessionIdOf(tokens.refreshToken),
        tokenHash: expect.stringMatching(/^[\w-]{43}$/),
        generation: 0,
        revokedAt: null,
      });
      expect(doc?.previousTokenHash).toBeUndefined();
      // Idle 30 days, absolute 180 days, purge 7 days after expiry.
      const created = (doc?.createdAt as Date).getTime();
      expect((doc?.expiresAt as Date).getTime() - created).toBeCloseTo(30 * DAY_MS, -4);
      expect((doc?.absoluteExpiresAt as Date).getTime() - created).toBeCloseTo(180 * DAY_MS, -4);
      expect((doc?.purgeAt as Date).getTime() - (doc?.expiresAt as Date).getTime()).toBe(
        7 * DAY_MS,
      );
    });
  });

  describe('rotation', () => {
    it('T0 → T1: returns a new pair; the new access token works', async () => {
      const { tokens: t0 } = await register(app);
      const t1 = await rotate(t0.refreshToken);
      expect(t1.refreshToken).not.toBe(t0.refreshToken);
      expect(sessionIdOf(t1.refreshToken)).toBe(sessionIdOf(t0.refreshToken));
      expect(t1).toMatchObject({ tokenType: 'Bearer', accessTokenExpiresIn: 900 });
      await me(app, t1.accessToken).expect(200);

      const doc = await sessionDoc(app, t1.refreshToken);
      expect(doc).toMatchObject({ generation: 1, lastRotatedAt: expect.any(Date) });
      expect(doc?.previousTokenHash).toEqual(expect.any(String));
      expect(doc?.previousTokenHash).not.toBe(doc?.tokenHash);
    });

    it('keeps only one previous hash', async () => {
      const { tokens: t0 } = await register(app);
      const t1 = await rotate(t0.refreshToken);
      const afterFirst = await sessionDoc(app, t1.refreshToken);
      const t2 = await rotate(t1.refreshToken);
      const afterSecond = await sessionDoc(app, t2.refreshToken);
      expect(afterSecond?.previousTokenHash).toBe(afterFirst?.tokenHash);
      expect(Object.keys(afterSecond ?? {})).not.toContain('previousTokenHashes');
    });

    it('T0 cannot be used again normally after rotation (within the grace window → invalid, no revoke)', async () => {
      const { tokens: t0 } = await register(app);
      const t1 = await rotate(t0.refreshToken);
      const res = await refresh(app, t0.refreshToken).expect(401);
      expectError(res.body, 'INVALID_REFRESH_TOKEN');
      expect((await sessionDoc(app, t1.refreshToken))?.revokedAt).toBeNull();
      await rotate(t1.refreshToken);
    });

    it('extends idle expiry on rotation but never beyond the absolute expiry', async () => {
      const { tokens } = await register(app);
      const absolute = new Date(Date.now() + 2 * DAY_MS);
      await patchSession(app, tokens.refreshToken, { absoluteExpiresAt: absolute });
      const next = await rotate(tokens.refreshToken);
      expect(new Date(next.refreshTokenExpiresAt).getTime()).toBe(absolute.getTime());
    });
  });

  describe('concurrent refresh', () => {
    it('two simultaneous refreshes with T0: exactly one succeeds and the session survives', async () => {
      const { tokens: t0 } = await register(app);
      const [a, b] = await Promise.all([
        refresh(app, t0.refreshToken),
        refresh(app, t0.refreshToken),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 401]);
      const loser = a.status === 401 ? a : b;
      const winner = a.status === 200 ? a : b;
      expectError(loser.body, 'INVALID_REFRESH_TOKEN');

      const doc = await sessionDoc(app, t0.refreshToken);
      expect(doc?.revokedAt).toBeNull();
      expect(doc?.generation).toBe(1);
      await rotate((winner.body as { tokens: Tokens }).tokens.refreshToken);
    });

    it('ten simultaneous refreshes with T0: exactly one succeeds', async () => {
      const { tokens: t0 } = await register(app);
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => refresh(app, t0.refreshToken)),
      );
      expect(responses.filter(res => res.status === 200)).toHaveLength(1);
      expect((await sessionDoc(app, t0.refreshToken))?.revokedAt).toBeNull();
    });
  });

  describe('replay detection', () => {
    it('previous token after the grace window → REFRESH_TOKEN_REUSED and only that session is revoked', async () => {
      const { user, password, tokens: deviceA0 } = await register(app);
      const deviceB = (await login(app, user.email, password)).tokens;

      const deviceA1 = await rotate(deviceA0.refreshToken);
      await patchSession(app, deviceA1.refreshToken, { lastRotatedAt: secondsAgo(16) });

      const replay = await refresh(app, deviceA0.refreshToken).expect(401);
      expect(replay.body.error).toMatchObject({
        code: 'REFRESH_TOKEN_REUSED',
        message: 'Refresh token was already used; the session has been revoked.',
      });
      expect(await sessionDoc(app, deviceA1.refreshToken)).toMatchObject({
        revokedAt: expect.any(Date),
        revokedReason: 'reuse',
      });

      // The legitimate newest token of that session is dead too…
      expectError(
        (await refresh(app, deviceA1.refreshToken).expect(401)).body,
        'INVALID_REFRESH_TOKEN',
      );
      // …but device B is untouched.
      await rotate(deviceB.refreshToken);
    });

    it('previous token exactly inside the window (14 s) is not treated as reuse', async () => {
      const { tokens: t0 } = await register(app);
      const t1 = await rotate(t0.refreshToken);
      await patchSession(app, t1.refreshToken, { lastRotatedAt: secondsAgo(14) });
      expectError((await refresh(app, t0.refreshToken).expect(401)).body, 'INVALID_REFRESH_TOKEN');
      expect((await sessionDoc(app, t1.refreshToken))?.revokedAt).toBeNull();
    });

    it('a token two generations old is invalid but does not revoke', async () => {
      const { tokens: t0 } = await register(app);
      const t1 = await rotate(t0.refreshToken);
      const t2 = await rotate(t1.refreshToken);
      await patchSession(app, t2.refreshToken, { lastRotatedAt: secondsAgo(60) });
      expectError((await refresh(app, t0.refreshToken).expect(401)).body, 'INVALID_REFRESH_TOKEN');
      expect((await sessionDoc(app, t2.refreshToken))?.revokedAt).toBeNull();
      await rotate(t2.refreshToken);
    });

    it('a random secret with a valid session id never revokes the session', async () => {
      const { tokens } = await register(app);
      const forged = `${sessionIdOf(tokens.refreshToken)}.${'A'.repeat(43)}`;
      for (let i = 0; i < 3; i += 1) {
        expectError((await refresh(app, forged).expect(401)).body, 'INVALID_REFRESH_TOKEN');
      }
      await http(app).post('/v1/auth/logout').send({ refreshToken: forged }).expect(204);
      expect((await sessionDoc(app, tokens.refreshToken))?.revokedAt).toBeNull();
      await rotate(tokens.refreshToken);
    });
  });

  describe('expiry', () => {
    it('idle-expired session → REFRESH_TOKEN_EXPIRED', async () => {
      const { tokens } = await register(app);
      await patchSession(app, tokens.refreshToken, { expiresAt: secondsAgo(1) });
      const res = await refresh(app, tokens.refreshToken).expect(401);
      expect(res.body.error).toMatchObject({
        code: 'REFRESH_TOKEN_EXPIRED',
        message: 'Refresh token has expired.',
      });
    });

    it('absolute-expired session → REFRESH_TOKEN_EXPIRED even if idle expiry is in the future', async () => {
      const { tokens } = await register(app);
      await patchSession(app, tokens.refreshToken, { absoluteExpiresAt: secondsAgo(1) });
      expectError(
        (await refresh(app, tokens.refreshToken).expect(401)).body,
        'REFRESH_TOKEN_EXPIRED',
      );
    });

    it('an expired session cannot be revived with a forged secret (invalid, not expired)', async () => {
      const { tokens } = await register(app);
      await patchSession(app, tokens.refreshToken, { expiresAt: secondsAgo(1) });
      const forged = `${sessionIdOf(tokens.refreshToken)}.${'B'.repeat(43)}`;
      expectError((await refresh(app, forged).expect(401)).body, 'INVALID_REFRESH_TOKEN');
    });
  });

  describe('invalid input', () => {
    it.each([
      ['garbage', 'garbage'],
      ['unknown session', `ses_AAAAAAAAAAAAAAAA.${'C'.repeat(43)}`],
      ['wrong prefix', `usr_AAAAAAAAAAAAAAAA.${'C'.repeat(43)}`],
      ['short secret', 'ses_AAAAAAAAAAAAAAAA.abc'],
      ['no separator', `ses_AAAAAAAAAAAAAAAA${'C'.repeat(43)}`],
    ])('%s → 401 INVALID_REFRESH_TOKEN', async (_case, token) => {
      expectError((await refresh(app, token).expect(401)).body, 'INVALID_REFRESH_TOKEN');
    });

    it.each([
      [{}, 'required'],
      [{ refreshToken: '' }, 'required'],
      [{ refreshToken: 42 }, 'invalid'],
      [{ refreshToken: 'x'.repeat(257) }, 'invalid'],
    ])('malformed body %# → 400', async (body, code) => {
      const res = await http(app).post('/v1/auth/refresh').send(body).expect(400);
      expect(res.body.error.details).toEqual([{ field: 'refreshToken', code }]);
    });
  });

  describe('logout', () => {
    it('revokes the session (204); its refresh token stops working', async () => {
      const { tokens } = await register(app);
      const res = await http(app)
        .post('/v1/auth/logout')
        .send({ refreshToken: tokens.refreshToken })
        .expect(204);
      expect(res.text).toBe('');
      expect(await sessionDoc(app, tokens.refreshToken)).toMatchObject({
        revokedAt: expect.any(Date),
        revokedReason: 'logout',
      });
      expectError(
        (await refresh(app, tokens.refreshToken).expect(401)).body,
        'INVALID_REFRESH_TOKEN',
      );
    });

    it('is idempotent and silent for unknown or garbage tokens', async () => {
      const { tokens } = await register(app);
      for (const refreshToken of [
        tokens.refreshToken,
        tokens.refreshToken,
        'garbage',
        `ses_AAAAAAAAAAAAAAAA.${'D'.repeat(43)}`,
      ]) {
        await http(app).post('/v1/auth/logout').send({ refreshToken }).expect(204);
      }
    });

    it('accepts the previous token too (a client that lost a refresh race can still sign out)', async () => {
      const { tokens: t0 } = await register(app);
      const t1 = await rotate(t0.refreshToken);
      await http(app).post('/v1/auth/logout').send({ refreshToken: t0.refreshToken }).expect(204);
      expectError((await refresh(app, t1.refreshToken).expect(401)).body, 'INVALID_REFRESH_TOKEN');
    });

    it('needs no access token', async () => {
      const { tokens } = await register(app);
      await http(app)
        .post('/v1/auth/logout')
        .set('authorization', 'Bearer not.a.jwt')
        .send({ refreshToken: tokens.refreshToken })
        .expect(204);
    });

    it('leaves already-issued access tokens valid until they expire (stateless, by design)', async () => {
      const { tokens } = await register(app);
      await http(app)
        .post('/v1/auth/logout')
        .send({ refreshToken: tokens.refreshToken })
        .expect(204);
      await me(app, tokens.accessToken).expect(200);
    });
  });

  describe('multiple devices', () => {
    it('logging out device A does not affect device B', async () => {
      const { user, password, tokens: deviceA } = await register(app);
      const deviceB = (await login(app, user.email, password)).tokens;
      await http(app)
        .post('/v1/auth/logout')
        .send({ refreshToken: deviceA.refreshToken })
        .expect(204);

      expectError(
        (await refresh(app, deviceA.refreshToken).expect(401)).body,
        'INVALID_REFRESH_TOKEN',
      );
      const nextB = await rotate(deviceB.refreshToken);
      await me(app, nextB.accessToken).expect(200);
    });

    it('sessions rotate independently', async () => {
      const { user, password, tokens: a0 } = await register(app);
      const b0 = (await login(app, user.email, password)).tokens;
      const a1 = await rotate(a0.refreshToken);
      const b1 = await rotate(b0.refreshToken);
      await rotate(a1.refreshToken);
      await rotate(b1.refreshToken);
    });
  });

  describe('deleted user', () => {
    it('refresh fails and the session is revoked', async () => {
      const { user, tokens } = await register(app);
      await collection(app, 'users').deleteOne({ publicId: user.id });
      expectError(
        (await refresh(app, tokens.refreshToken).expect(401)).body,
        'INVALID_REFRESH_TOKEN',
      );
      expect((await sessionDoc(app, tokens.refreshToken))?.revokedAt).toEqual(expect.any(Date));
    });
  });
});
