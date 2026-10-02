import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { expectError } from './support/auth-helpers.js';
import {
  getCouple,
  insertPartnerMembership,
  raw,
  signedInUser,
  userWithCouple,
} from './support/couple-helpers.js';
import {
  creatorWithInvite,
  ensureInvite,
  expireInvite,
  inviteDoc,
  joinInvite,
  lookupInvite,
  regenerateInvite,
} from './support/invite-helpers.js';
import { captureLogs, closeTestApp, createTestApp } from './support/test-app.js';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { CoupleInvitesService } from '../src/modules/couples/couple-invites.service.js';
import type { InviteCodeGenerator } from '../src/modules/couples/invite-code.generator.js';
import type { InviteBody } from './support/invite-helpers.js';
import type { LogCapture } from './support/test-app.js';

const HOUR_MS = 60 * 60 * 1000;

describe('creator invites: POST /v1/couples/:id/invite and /invite/regenerate', () => {
  let app: NestExpressApplication;
  let logs: LogCapture;
  let services: { codes: InviteCodeGenerator; invites: CoupleInvitesService };

  beforeAll(async () => {
    logs = captureLogs();
    app = await createTestApp({ throttling: false, env: { LOG_LEVEL: 'info' }, logs });
    // Resolved now: creating another app later re-imports the modules (new class identities).
    const [{ InviteCodeGenerator }, { CoupleInvitesService }] = await Promise.all([
      import('../src/modules/couples/invite-code.generator.js'),
      import('../src/modules/couples/couple-invites.service.js'),
    ]);
    services = { codes: app.get(InviteCodeGenerator), invites: app.get(CoupleInvitesService) };
  });

  afterAll(() => closeTestApp(app));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function invitesOf(couplePublicId: string) {
    const couple = await raw(app, 'couples').findOne({ publicId: couplePublicId });
    return raw(app, 'couple_invites').find({ coupleId: couple?._id }).toArray();
  }

  describe('ensure', () => {
    it('issues a six-digit invite with the configured 24 h expiry', async () => {
      const { token, couple } = await userWithCouple(app);
      const before = Date.now();
      const res = await ensureInvite(app, token, couple.id).expect(200);

      expect(Object.keys(res.body).sort()).toEqual(['code', 'expiresAt', 'expiresInSeconds']);
      const invite = res.body as InviteBody;
      expect(invite.code).toMatch(/^[1-9]\d{5}$/);
      const expiresAt = Date.parse(invite.expiresAt);
      expect(expiresAt).toBeGreaterThanOrEqual(before + 24 * HOUR_MS);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 24 * HOUR_MS);
      expect(invite.expiresInSeconds).toBeGreaterThan(24 * 3600 - 10);
      expect(invite.expiresInSeconds).toBeLessThanOrEqual(24 * 3600);

      const doc = await inviteDoc(app, invite.code);
      expect(doc).toMatchObject({ status: 'active', code: invite.code });
      expect((doc?.purgeAt as Date).getTime()).toBe(expiresAt + 24 * HOUR_MS);
      expect(doc).not.toHaveProperty('redeemedAt');
      expect(doc).not.toHaveProperty('redeemedByUserId');
    });

    it('returns the same usable invite again without writing anything', async () => {
      const { token, couple, invite } = await creatorWithInvite(app);
      const coupleBefore = await raw(app, 'couples').findOne({ publicId: couple.id });
      const docBefore = await inviteDoc(app, invite.code);

      const again = await ensureInvite(app, token, couple.id).expect(200);
      expect(again.body.code).toBe(invite.code);
      expect(again.body.expiresAt).toBe(invite.expiresAt);
      expect(await invitesOf(couple.id)).toHaveLength(1);
      expect(await inviteDoc(app, invite.code)).toEqual(docBefore);
      expect(await raw(app, 'couples').findOne({ publicId: couple.id })).toEqual(coupleBefore);
    });

    it('replaces an expired invite: the old one is revoked, the new one has a fresh expiry', async () => {
      const { token, couple, invite } = await creatorWithInvite(app);
      await expireInvite(app, invite.code);

      const res = await ensureInvite(app, token, couple.id).expect(200);
      expect(res.body.code).not.toBe(invite.code);
      expect(Date.parse(res.body.expiresAt)).toBeGreaterThan(Date.now() + 23 * HOUR_MS);
      expect(await inviteDoc(app, invite.code)).toMatchObject({ status: 'revoked' });
      expect(await inviteDoc(app, res.body.code)).toMatchObject({ status: 'active' });
    });

    it('honours INVITE_TTL_HOURS', async () => {
      const shortApp = await createTestApp({ throttling: false, env: { INVITE_TTL_HOURS: '2' } });
      try {
        const { token, couple } = await userWithCouple(shortApp);
        const res = await ensureInvite(shortApp, token, couple.id).expect(200);
        expect(res.body.expiresInSeconds).toBeLessThanOrEqual(2 * 3600);
        expect(res.body.expiresInSeconds).toBeGreaterThan(2 * 3600 - 10);
      } finally {
        await closeTestApp(shortApp);
      }
    });

    it('five simultaneous calls: one invite, and every caller gets the same code', async () => {
      const { token, couple } = await userWithCouple(app);
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => ensureInvite(app, token, couple.id)),
      );
      expect(responses.map(res => res.status)).toEqual([200, 200, 200, 200, 200]);
      expect(new Set(responses.map(res => res.body.code as string)).size).toBe(1);
      expect(await invitesOf(couple.id)).toHaveLength(1);
    });
  });

  describe('regenerate', () => {
    it('issues a new code with a fresh expiry; the old code stops working immediately', async () => {
      const { token, couple, invite } = await creatorWithInvite(app);
      await expireInvite(app, invite.code); // so a reset expiry is observable

      const res = await regenerateInvite(app, token, couple.id).expect(200);
      expect(res.body.code).not.toBe(invite.code);
      expect(Date.parse(res.body.expiresAt)).toBeGreaterThan(Date.now() + 23 * HOUR_MS);
      expect(await inviteDoc(app, invite.code)).toMatchObject({ status: 'revoked' });

      const partner = await signedInUser(app, 'Linh');
      expectError(
        (await lookupInvite(app, partner.token, invite.code).expect(410)).body,
        'INVITE_EXPIRED',
      );
      expectError(
        (await joinInvite(app, partner.token, invite.code).expect(410)).body,
        'INVITE_EXPIRED',
      );
      expect((await lookupInvite(app, partner.token, res.body.code).expect(200)).body).toEqual({
        ownerName: 'Minh',
      });
    });

    it('replaces a still-usable code too', async () => {
      const { token, couple, invite } = await creatorWithInvite(app);
      const res = await regenerateInvite(app, token, couple.id).expect(200);
      expect(res.body.code).not.toBe(invite.code);
      expect(await inviteDoc(app, invite.code)).toMatchObject({ status: 'revoked' });
      const revoked = await inviteDoc(app, invite.code);
      expect((revoked?.purgeAt as Date).getTime()).toBeGreaterThan(Date.now() + 23 * HOUR_MS);
    });

    it('works when no invite exists yet', async () => {
      const { token, couple } = await userWithCouple(app);
      const res = await regenerateInvite(app, token, couple.id).expect(200);
      expect(await inviteDoc(app, res.body.code)).toMatchObject({ status: 'active' });
    });

    it('five simultaneous regenerates: exactly one active invite remains, the rest are revoked', async () => {
      const { token, couple } = await creatorWithInvite(app);
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => regenerateInvite(app, token, couple.id)),
      );
      expect(responses.map(res => res.status)).toEqual([200, 200, 200, 200, 200]);

      const docs = await invitesOf(couple.id);
      expect(docs).toHaveLength(6);
      const active = docs.filter(doc => doc.status === 'active');
      expect(active).toHaveLength(1);
      expect(docs.filter(doc => doc.status === 'revoked')).toHaveLength(5);
      // The surviving code is one of the returned ones; the others are already revoked.
      expect(responses.map(res => res.body.code as string)).toContain(active[0].code);
    });

    it('rolls back the revocation when inserting the new invite fails', async () => {
      const { token, couple, invite } = await creatorWithInvite(app);
      const { invites } = services;
      vi.spyOn(invites, 'insert').mockRejectedValueOnce(new Error('simulated failure'));

      await regenerateInvite(app, token, couple.id).expect(500);
      expect(await inviteDoc(app, invite.code)).toMatchObject({ status: 'active' });
      expect(await invitesOf(couple.id)).toHaveLength(1);
    });
  });

  describe('code collisions', () => {
    it('retries with a fresh code when the generated one is taken', async () => {
      const first = await creatorWithInvite(app);
      const { token, couple } = await userWithCouple(app);
      const { codes } = services;
      const real = codes.next.bind(codes);
      let fresh = '';
      vi.spyOn(codes, 'next')
        .mockReturnValueOnce(first.invite.code)
        .mockReturnValueOnce(first.invite.code)
        .mockImplementationOnce(() => (fresh = real()));

      const res = await ensureInvite(app, token, couple.id).expect(200);
      expect(res.body.code).toBe(fresh);
      expect(await inviteDoc(app, first.invite.code)).toMatchObject({ status: 'active' });
      const collisions = logs.lines().filter(line => line.msg === 'invite.code_collision');
      expect(collisions.length).toBeGreaterThanOrEqual(2);
    });

    it('gives up after five collisions with 503 and creates nothing (code never logged)', async () => {
      const first = await creatorWithInvite(app);
      const { token, couple } = await userWithCouple(app);
      const { codes } = services;
      vi.spyOn(codes, 'next').mockReturnValue(first.invite.code);

      const res = await ensureInvite(app, token, couple.id).expect(503);
      expectError(res.body, 'SERVICE_UNAVAILABLE');
      expect(JSON.stringify(res.body)).not.toContain(first.invite.code);
      expect(await invitesOf(couple.id)).toHaveLength(0);
      expect(logs.raw()).not.toContain(`"${first.invite.code}"`);
      expect(logs.raw()).not.toContain(`: ${first.invite.code}`);
    });
  });

  describe('access rules (both endpoints)', () => {
    for (const [name, call] of [
      ['ensure', ensureInvite],
      ['regenerate', regenerateInvite],
    ] as const) {
      describe(name, () => {
        it('hides the couple from non-members, unknown and malformed ids (404)', async () => {
          const { couple } = await userWithCouple(app);
          const stranger = await signedInUser(app);
          for (const id of [couple.id, 'cpl_AAAAAAAAAAAAAAAA', 'nope']) {
            expectError((await call(app, stranger.token, id).expect(404)).body, 'COUPLE_NOT_FOUND');
          }
          expect(await invitesOf(couple.id)).toHaveLength(0);
        });

        it('requires authentication', async () => {
          const { couple } = await userWithCouple(app);
          await call(app, 'not-a-token', couple.id).expect(401);
        });

        it('refuses an active couple (409 COUPLE_NOT_PENDING)', async () => {
          const { token, couple, invite } = await creatorWithInvite(app);
          const partner = await signedInUser(app, 'Linh');
          await joinInvite(app, partner.token, invite.code).expect(200);

          expectError((await call(app, token, couple.id).expect(409)).body, 'COUPLE_NOT_PENDING');
          expectError(
            (await call(app, partner.token, couple.id).expect(409)).body,
            'COUPLE_NOT_PENDING',
          );
          expect(await invitesOf(couple.id)).toHaveLength(1);
        });

        it('forbids a member who is not the creator (403) – partner inserted directly', async () => {
          const { couple } = await userWithCouple(app);
          const partner = await signedInUser(app, 'Linh');
          await insertPartnerMembership(app, couple.id, partner.user.id);
          expectError((await call(app, partner.token, couple.id).expect(403)).body, 'FORBIDDEN');
        });
      });
    }
  });

  it('the couple read model is unchanged by issuing invites', async () => {
    const { token, couple } = await creatorWithInvite(app);
    const res = await getCouple(app, token, couple.id).expect(200);
    expect(res.body).not.toHaveProperty('invite');
    expect(res.body.status).toBe('pending');
  });
});
