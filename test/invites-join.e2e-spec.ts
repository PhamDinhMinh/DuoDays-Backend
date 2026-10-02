import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { expectError, me } from './support/auth-helpers.js';
import {
  getCouple,
  internalIds,
  raw,
  signedInUser,
  userWithCouple,
} from './support/couple-helpers.js';
import {
  cancelCouple,
  creatorWithInvite,
  expireInvite,
  inviteDoc,
  joinInvite,
  lookupInvite,
  patchInvite,
  regenerateInvite,
  unusedCode,
} from './support/invite-helpers.js';
import { closeTestApp, createTestApp } from './support/test-app.js';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { CoupleMembershipsService } from '../src/modules/couples/couple-memberships.service.js';
import type { CouplesService } from '../src/modules/couples/couples.service.js';

describe('partner side: POST /v1/invites/lookup and /v1/invites/join', () => {
  let app: NestExpressApplication;
  let services: { memberships: CoupleMembershipsService; couples: CouplesService };

  beforeAll(async () => {
    app = await createTestApp({ throttling: false });
    const [{ CoupleMembershipsService }, { CouplesService }] = await Promise.all([
      import('../src/modules/couples/couple-memberships.service.js'),
      import('../src/modules/couples/couples.service.js'),
    ]);
    services = { memberships: app.get(CoupleMembershipsService), couples: app.get(CouplesService) };
  });

  afterAll(() => closeTestApp(app));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function stateOf(couplePublicId: string, code: string) {
    const couple = await raw(app, 'couples').findOne({ publicId: couplePublicId });
    const memberships = await raw(app, 'couple_memberships')
      .find({ coupleId: couple?._id, status: 'active' })
      .toArray();
    return { couple, invite: await inviteDoc(app, code), memberships };
  }

  describe('lookup', () => {
    it('returns only the creator’s display name for a usable code', async () => {
      const { invite } = await creatorWithInvite(app);
      const partner = await signedInUser(app, 'Linh');
      const res = await lookupInvite(app, partner.token, invite.code).expect(200);
      expect(res.body).toEqual({ ownerName: 'Minh' });
    });

    it('has no side effects', async () => {
      const { couple, invite } = await creatorWithInvite(app);
      const before = await stateOf(couple.id, invite.code);
      const partner = await signedInUser(app, 'Linh');
      await lookupInvite(app, partner.token, invite.code).expect(200);
      expect(await stateOf(couple.id, invite.code)).toEqual(before);
    });

    it('404 INVITE_NOT_FOUND for a code nobody holds (including leading-zero codes)', async () => {
      const partner = await signedInUser(app, 'Linh');
      for (const code of [await unusedCode(app), '012345']) {
        expectError(
          (await lookupInvite(app, partner.token, code).expect(404)).body,
          'INVITE_NOT_FOUND',
        );
      }
    });

    it('410 INVITE_EXPIRED once expiresAt has passed (no TTL deletion needed)', async () => {
      const { invite } = await creatorWithInvite(app);
      await expireInvite(app, invite.code);
      const partner = await signedInUser(app, 'Linh');
      expectError(
        (await lookupInvite(app, partner.token, invite.code).expect(410)).body,
        'INVITE_EXPIRED',
      );
    });

    it('410 INVITE_EXPIRED exactly at expiresAt (expiry is now >= expiresAt)', async () => {
      const { invite } = await creatorWithInvite(app);
      await patchInvite(app, invite.code, { expiresAt: new Date() });
      const partner = await signedInUser(app, 'Linh');
      await lookupInvite(app, partner.token, invite.code).expect(410);
    });

    it('410 INVITE_EXPIRED for a revoked code (replaced or couple cancelled)', async () => {
      const replaced = await creatorWithInvite(app);
      await regenerateInvite(app, replaced.token, replaced.couple.id).expect(200);
      const cancelled = await creatorWithInvite(app);
      await cancelCouple(app, cancelled.token, cancelled.couple.id).expect(204);

      const partner = await signedInUser(app, 'Linh');
      for (const code of [replaced.invite.code, cancelled.invite.code]) {
        expectError(
          (await lookupInvite(app, partner.token, code).expect(410)).body,
          'INVITE_EXPIRED',
        );
      }
    });

    it('409 INVITE_ALREADY_REDEEMED for a used code', async () => {
      const { invite } = await creatorWithInvite(app);
      await joinInvite(app, (await signedInUser(app, 'Linh')).token, invite.code).expect(200);
      const late = await signedInUser(app, 'Late');
      expectError(
        (await lookupInvite(app, late.token, invite.code).expect(409)).body,
        'INVITE_ALREADY_REDEEMED',
      );
    });

    it('409 ALREADY_IN_COUPLE for the creator’s own code and for anyone already in a couple', async () => {
      const { token, invite } = await creatorWithInvite(app);
      expectError(
        (await lookupInvite(app, token, invite.code).expect(409)).body,
        'ALREADY_IN_COUPLE',
      );

      const other = await userWithCouple(app);
      expectError(
        (await lookupInvite(app, other.token, invite.code).expect(409)).body,
        'ALREADY_IN_COUPLE',
      );
      // Decided before the code is looked at: no oracle for members.
      expectError(
        (await lookupInvite(app, other.token, await unusedCode(app)).expect(409)).body,
        'ALREADY_IN_COUPLE',
      );
    });

    it('rejects malformed codes with 400 and never echoes the value', async () => {
      const partner = await signedInUser(app, 'Linh');
      for (const code of ['12345', '1234567', '12 345', 'abcdef', 123456, null, '']) {
        const res = await lookupInvite(app, partner.token, code).expect(400);
        expectError(res.body, 'VALIDATION_FAILED');
        expect(res.body.error.details[0].field).toBe('code');
        expect(JSON.stringify(res.body)).not.toContain('abcdef');
      }
      const missing = await lookupInvite(app, partner.token, undefined).expect(400);
      expect(missing.body.error.details).toEqual([{ field: 'code', code: 'required' }]);
    });

    it('requires authentication; a deleted caller is 401', async () => {
      const { invite } = await creatorWithInvite(app);
      await lookupInvite(app, 'not-a-token', invite.code).expect(401);

      const ghost = await signedInUser(app);
      await raw(app, 'users').deleteOne({ publicId: ghost.user.id });
      expectError(
        (await lookupInvite(app, ghost.token, invite.code).expect(401)).body,
        'UNAUTHENTICATED',
      );
    });
  });

  describe('join', () => {
    it('activates the couple, adds the partner and redeems the invite – one transaction', async () => {
      const { couple, invite, user: creator } = await creatorWithInvite(app);
      const partner = await signedInUser(app, 'Linh');
      const before = Date.now();

      const res = await joinInvite(app, partner.token, invite.code).expect(200);
      expect(res.body).toEqual({
        id: couple.id,
        status: 'active',
        startDate: couple.startDate,
        members: [
          { id: creator.id, displayName: 'Minh', role: 'creator' },
          { id: partner.user.id, displayName: 'Linh', role: 'partner' },
        ],
        createdAt: couple.createdAt,
      });

      const state = await stateOf(couple.id, invite.code);
      expect(state.couple?.status).toBe('active');
      expect(state.couple).not.toHaveProperty('pendingPartnerName');
      expect(state.memberships).toHaveLength(2);

      const { userId: partnerId } = await internalIds(app, partner.user.id);
      expect(state.invite).toMatchObject({ status: 'redeemed', redeemedByUserId: partnerId });
      const redeemedAt = (state.invite?.redeemedAt as Date).getTime();
      expect(redeemedAt).toBeGreaterThanOrEqual(before - 5);
      expect(redeemedAt).toBeLessThanOrEqual(Date.now());
      expect((state.invite?.purgeAt as Date).getTime()).toBe(redeemedAt + 24 * 60 * 60 * 1000);
    });

    it('polling: the creator’s GET flips from pending to active with the partner; /auth/me follows', async () => {
      const { token, couple, invite } = await creatorWithInvite(app);
      const pending = await getCouple(app, token, couple.id).expect(200);
      expect(pending.body).toMatchObject({ status: 'pending', pendingPartnerName: 'Linh' });
      expect(pending.body.members).toHaveLength(1);
      expect((await me(app, token).expect(200)).body.activeCouple).toEqual({
        id: couple.id,
        status: 'pending',
      });

      const partner = await signedInUser(app, 'Linh');
      await joinInvite(app, partner.token, invite.code).expect(200);

      const active = await getCouple(app, token, couple.id).expect(200);
      expect(active.body.status).toBe('active');
      expect(active.body).not.toHaveProperty('pendingPartnerName');
      const members = active.body.members as { role: string }[];
      expect(members.map(member => member.role)).toEqual(['creator', 'partner']);
      expect((await getCouple(app, partner.token, couple.id).expect(200)).body).toEqual(
        active.body,
      );
      for (const t of [token, partner.token]) {
        expect((await me(app, t).expect(200)).body.activeCouple).toEqual({
          id: couple.id,
          status: 'active',
        });
      }
      // Still invisible to everyone else.
      const stranger = await signedInUser(app);
      await getCouple(app, stranger.token, couple.id).expect(404);
    });

    it('the creator cannot join their own invite', async () => {
      const { token, couple, invite } = await creatorWithInvite(app);
      expectError(
        (await joinInvite(app, token, invite.code).expect(409)).body,
        'ALREADY_IN_COUPLE',
      );
      const state = await stateOf(couple.id, invite.code);
      expect(state.invite?.status).toBe('active');
      expect(state.couple?.status).toBe('pending');
    });

    it('a user in another couple cannot join', async () => {
      const { couple, invite } = await creatorWithInvite(app);
      const other = await userWithCouple(app);
      expectError(
        (await joinInvite(app, other.token, invite.code).expect(409)).body,
        'ALREADY_IN_COUPLE',
      );
      expect((await stateOf(couple.id, invite.code)).memberships).toHaveLength(1);
    });

    it('unknown, expired, revoked and used codes', async () => {
      const partner = await signedInUser(app, 'Linh');
      expectError(
        (await joinInvite(app, partner.token, await unusedCode(app)).expect(404)).body,
        'INVITE_NOT_FOUND',
      );

      const expired = await creatorWithInvite(app);
      await expireInvite(app, expired.invite.code);
      expectError(
        (await joinInvite(app, partner.token, expired.invite.code).expect(410)).body,
        'INVITE_EXPIRED',
      );
      expect((await stateOf(expired.couple.id, expired.invite.code)).couple?.status).toBe(
        'pending',
      );

      const revoked = await creatorWithInvite(app);
      await regenerateInvite(app, revoked.token, revoked.couple.id).expect(200);
      expectError(
        (await joinInvite(app, partner.token, revoked.invite.code).expect(410)).body,
        'INVITE_EXPIRED',
      );

      const used = await creatorWithInvite(app);
      await joinInvite(app, (await signedInUser(app, 'First')).token, used.invite.code).expect(200);
      expectError(
        (await joinInvite(app, partner.token, used.invite.code).expect(409)).body,
        'INVITE_ALREADY_REDEEMED',
      );
    });

    it('expired between lookup and join → 410', async () => {
      const { invite } = await creatorWithInvite(app);
      const partner = await signedInUser(app, 'Linh');
      await lookupInvite(app, partner.token, invite.code).expect(200);
      await expireInvite(app, invite.code);
      await joinInvite(app, partner.token, invite.code).expect(410);
    });

    it('regenerated between lookup and join → 410 for the old code, the new one works', async () => {
      const { token, couple, invite } = await creatorWithInvite(app);
      const partner = await signedInUser(app, 'Linh');
      await lookupInvite(app, partner.token, invite.code).expect(200);
      const fresh = await regenerateInvite(app, token, couple.id).expect(200);
      await joinInvite(app, partner.token, invite.code).expect(410);
      await joinInvite(app, partner.token, fresh.body.code).expect(200);
    });

    it('a cancelled couple cannot be joined', async () => {
      const { token, couple, invite } = await creatorWithInvite(app);
      await cancelCouple(app, token, couple.id).expect(204);
      const partner = await signedInUser(app, 'Linh');
      await joinInvite(app, partner.token, invite.code).expect(410);
      expect((await stateOf(couple.id, invite.code)).couple?.status).toBe('cancelled');
    });

    describe('idempotency', () => {
      it('repeating a successful join returns the same couple (200), with no new writes', async () => {
        const { couple, invite } = await creatorWithInvite(app);
        const partner = await signedInUser(app, 'Linh');
        const first = await joinInvite(app, partner.token, invite.code).expect(200);
        const state = await stateOf(couple.id, invite.code);

        const again = await joinInvite(app, partner.token, invite.code).expect(200);
        expect(again.body).toEqual(first.body);
        expect(await stateOf(couple.id, invite.code)).toEqual(state);
      });

      it('a different user still gets INVITE_ALREADY_REDEEMED; the partner with another code gets ALREADY_IN_COUPLE', async () => {
        const { invite } = await creatorWithInvite(app);
        const partner = await signedInUser(app, 'Linh');
        await joinInvite(app, partner.token, invite.code).expect(200);

        await joinInvite(app, (await signedInUser(app, 'Other')).token, invite.code).expect(409);
        const second = await creatorWithInvite(app);
        expectError(
          (await joinInvite(app, partner.token, second.invite.code).expect(409)).body,
          'ALREADY_IN_COUPLE',
        );
      });

      it('the creator replaying the partner’s code is not treated as a replay', async () => {
        const { token, invite } = await creatorWithInvite(app);
        await joinInvite(app, (await signedInUser(app, 'Linh')).token, invite.code).expect(200);
        expectError(
          (await joinInvite(app, token, invite.code).expect(409)).body,
          'ALREADY_IN_COUPLE',
        );
      });
    });

    // Join vs regenerate/cancel orderings: couples-setup-races.e2e-spec.ts (deterministic).
    describe('races', () => {
      it('two users join the same invite at once: exactly one becomes the partner', async () => {
        const { couple, invite } = await creatorWithInvite(app);
        const [a, b] = await Promise.all([signedInUser(app, 'A'), signedInUser(app, 'B')]);
        const responses = await Promise.all([
          joinInvite(app, a.token, invite.code),
          joinInvite(app, b.token, invite.code),
        ]);
        expect(responses.map(res => res.status).sort()).toEqual([200, 409]);
        expectError(responses.find(res => res.status === 409)?.body, 'INVITE_ALREADY_REDEEMED');

        const state = await stateOf(couple.id, invite.code);
        expect(state.memberships).toHaveLength(2);
        expect(state.couple?.status).toBe('active');
      });

      it('five users race: one partner, four rejections, never a third member', async () => {
        const { couple, invite } = await creatorWithInvite(app);
        const users = await Promise.all(
          Array.from({ length: 5 }, (_, i) => signedInUser(app, `U${i}`)),
        );
        const responses = await Promise.all(users.map(u => joinInvite(app, u.token, invite.code)));
        expect(responses.filter(res => res.status === 200)).toHaveLength(1);
        expect(responses.filter(res => res.status === 409)).toHaveLength(4);
        expect((await stateOf(couple.id, invite.code)).memberships).toHaveLength(2);
      });

      it('the same user submits join three times at once: all succeed, one membership', async () => {
        const { couple, invite } = await creatorWithInvite(app);
        const partner = await signedInUser(app, 'Linh');
        const responses = await Promise.all(
          Array.from({ length: 3 }, () => joinInvite(app, partner.token, invite.code)),
        );
        expect(responses.map(res => res.status)).toEqual([200, 200, 200]);
        expect(new Set(responses.map(res => JSON.stringify(res.body))).size).toBe(1);
        const { userId } = await internalIds(app, partner.user.id);
        expect(await raw(app, 'couple_memberships').countDocuments({ userId })).toBe(1);
        expect((await stateOf(couple.id, invite.code)).memberships).toHaveLength(2);
      });

      it('a user who loses the race to create their own couple cannot also join (index-enforced)', async () => {
        const { couple, invite } = await creatorWithInvite(app);
        const { token } = await userWithCouple(app);
        // Simulate the pre-check missing the caller's membership: the unique index still says no.
        vi.spyOn(services.memberships, 'findActiveByUser').mockResolvedValueOnce(null);

        expectError(
          (await joinInvite(app, token, invite.code).expect(409)).body,
          'ALREADY_IN_COUPLE',
        );
        const state = await stateOf(couple.id, invite.code);
        expect(state.invite?.status).toBe('active');
        expect(state.couple?.status).toBe('pending');
        expect(state.memberships).toHaveLength(1);
      });
    });

    describe('atomicity', () => {
      it('rolls back the redemption when activating the couple fails', async () => {
        const { couple, invite } = await creatorWithInvite(app);
        vi.spyOn(services.couples, 'activatePending').mockRejectedValueOnce(new Error('simulated'));
        const partner = await signedInUser(app, 'Linh');

        await joinInvite(app, partner.token, invite.code).expect(500);
        const state = await stateOf(couple.id, invite.code);
        expect(state.invite).toMatchObject({ status: 'active' });
        expect(state.invite).not.toHaveProperty('redeemedAt');
        expect(state.couple?.status).toBe('pending');

        // Nothing half-done blocks a clean retry.
        await joinInvite(app, partner.token, invite.code).expect(200);
      });

      it('rolls back redemption and activation when the membership insert fails', async () => {
        const { couple, invite } = await creatorWithInvite(app);
        vi.spyOn(services.memberships, 'create').mockRejectedValueOnce(new Error('simulated'));
        const partner = await signedInUser(app, 'Linh');

        await joinInvite(app, partner.token, invite.code).expect(500);
        const state = await stateOf(couple.id, invite.code);
        expect(state.invite).toMatchObject({ status: 'active' });
        expect(state.invite).not.toHaveProperty('redeemedByUserId');
        expect(state.couple).toMatchObject({ status: 'pending', pendingPartnerName: 'Linh' });
        expect(state.memberships).toHaveLength(1);
      });

      it('survives a transient transaction error by retrying the whole callback', async () => {
        const { couple, invite } = await creatorWithInvite(app);
        // What a write conflict with a concurrent transaction looks like to the driver.
        const transient = new mongoose.mongo.MongoServerError({
          message: 'simulated write conflict',
          code: 112,
          errorLabels: ['TransientTransactionError'],
        });
        vi.spyOn(services.memberships, 'create').mockRejectedValueOnce(transient);
        const partner = await signedInUser(app, 'Linh');

        await joinInvite(app, partner.token, invite.code).expect(200);
        const state = await stateOf(couple.id, invite.code);
        expect(state.invite?.status).toBe('redeemed');
        expect(state.memberships).toHaveLength(2);
      });
    });
  });
});
