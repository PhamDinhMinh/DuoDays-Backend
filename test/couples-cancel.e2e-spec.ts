import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { expectError, me } from './support/auth-helpers.js';
import {
  createCouple,
  getCouple,
  insertPartnerMembership,
  internalIds,
  patchCouple,
  raw,
  signedInUser,
  userWithCouple,
  VALID_COUPLE,
} from './support/couple-helpers.js';
import {
  cancelCouple,
  creatorWithInvite,
  ensureInvite,
  inviteDoc,
  joinInvite,
} from './support/invite-helpers.js';
import { closeTestApp, createTestApp } from './support/test-app.js';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { CoupleInvitesService } from '../src/modules/couples/couple-invites.service.js';
import type { CoupleMembershipsService } from '../src/modules/couples/couple-memberships.service.js';

describe('POST /v1/couples/:coupleId/cancel', () => {
  let app: NestExpressApplication;
  let services: { memberships: CoupleMembershipsService; invites: CoupleInvitesService };

  beforeAll(async () => {
    app = await createTestApp({ throttling: false });
    const [{ CoupleMembershipsService }, { CoupleInvitesService }] = await Promise.all([
      import('../src/modules/couples/couple-memberships.service.js'),
      import('../src/modules/couples/couple-invites.service.js'),
    ]);
    services = {
      memberships: app.get(CoupleMembershipsService),
      invites: app.get(CoupleInvitesService),
    };
  });

  afterAll(() => closeTestApp(app));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function stateOf(couplePublicId: string, userPublicId: string, code?: string) {
    const { coupleId, userId } = await internalIds(app, userPublicId, couplePublicId);
    return {
      couple: await raw(app, 'couples').findOne({ _id: coupleId }),
      membership: await raw(app, 'couple_memberships').findOne({ coupleId, userId }),
      invite: code ? await inviteDoc(app, code) : null,
    };
  }

  it('soft-cancels: couple cancelled, membership left, invite revoked – nothing deleted', async () => {
    const { token, user, couple, invite } = await creatorWithInvite(app);
    const res = await cancelCouple(app, token, couple.id).expect(204);
    expect(res.text).toBe('');

    const state = await stateOf(couple.id, user.id, invite.code);
    expect(state.couple).toMatchObject({ status: 'cancelled', startDate: couple.startDate });
    expect(state.membership).toMatchObject({ status: 'left', role: 'creator' });
    expect(state.invite).toMatchObject({ status: 'revoked' });
  });

  it('works without any invite issued', async () => {
    const { token, user, couple } = await userWithCouple(app);
    await cancelCouple(app, token, couple.id).expect(204);
    expect((await stateOf(couple.id, user.id)).couple?.status).toBe('cancelled');
  });

  it('afterwards: /auth/me is null and the couple is gone for its former creator (404)', async () => {
    const { token, couple } = await creatorWithInvite(app);
    await cancelCouple(app, token, couple.id).expect(204);

    expect((await me(app, token).expect(200)).body.activeCouple).toBeNull();
    expectError((await getCouple(app, token, couple.id).expect(404)).body, 'COUPLE_NOT_FOUND');
    await patchCouple(app, token, couple.id, { partnerName: 'X' }).expect(404);
    await ensureInvite(app, token, couple.id).expect(404);
    // Repeating the cancel is a plain 404 (no longer a member).
    await cancelCouple(app, token, couple.id).expect(404);
  });

  it('the user can create a new couple straight away', async () => {
    const { token, couple } = await userWithCouple(app);
    await cancelCouple(app, token, couple.id).expect(204);

    const created = await createCouple(app, token, VALID_COUPLE).expect(201);
    expect(created.body.id).not.toBe(couple.id);
    expect((await me(app, token).expect(200)).body.activeCouple).toEqual({
      id: created.body.id,
      status: 'pending',
    });
    await ensureInvite(app, token, created.body.id).expect(200);
  });

  it('the user can join someone else’s couple straight away ("Join instead")', async () => {
    const mine = await creatorWithInvite(app);
    const theirs = await creatorWithInvite(app);
    await joinInvite(app, mine.token, theirs.invite.code).expect(409);

    await cancelCouple(app, mine.token, mine.couple.id).expect(204);
    const joined = await joinInvite(app, mine.token, theirs.invite.code).expect(200);
    expect(joined.body).toMatchObject({ id: theirs.couple.id, status: 'active' });
    expect((await me(app, mine.token).expect(200)).body.activeCouple).toEqual({
      id: theirs.couple.id,
      status: 'active',
    });
  });

  it('refuses an active couple (409 COUPLE_NOT_PENDING) for both members', async () => {
    const { token, couple, invite } = await creatorWithInvite(app);
    const partner = await signedInUser(app, 'Linh');
    await joinInvite(app, partner.token, invite.code).expect(200);

    expectError((await cancelCouple(app, token, couple.id).expect(409)).body, 'COUPLE_NOT_PENDING');
    expectError(
      (await cancelCouple(app, partner.token, couple.id).expect(409)).body,
      'COUPLE_NOT_PENDING',
    );
    expect((await getCouple(app, token, couple.id).expect(200)).body.status).toBe('active');
  });

  it('hides the couple from non-members, unknown and malformed ids (404)', async () => {
    const { user, couple } = await userWithCouple(app);
    const stranger = await signedInUser(app);
    for (const id of [couple.id, 'cpl_AAAAAAAAAAAAAAAA', 'nope']) {
      expectError(
        (await cancelCouple(app, stranger.token, id).expect(404)).body,
        'COUPLE_NOT_FOUND',
      );
    }
    expect((await stateOf(couple.id, user.id)).couple?.status).toBe('pending');
  });

  it('forbids a member who is not the creator (403) – partner inserted directly', async () => {
    const { couple } = await userWithCouple(app);
    const partner = await signedInUser(app, 'Linh');
    await insertPartnerMembership(app, couple.id, partner.user.id);
    expectError((await cancelCouple(app, partner.token, couple.id).expect(403)).body, 'FORBIDDEN');
  });

  it('requires authentication', async () => {
    const { couple } = await userWithCouple(app);
    await cancelCouple(app, 'not-a-token', couple.id).expect(401);
  });

  describe('atomicity', () => {
    it('rolls back the couple when ending the membership fails', async () => {
      const { token, user, couple, invite } = await creatorWithInvite(app);
      vi.spyOn(services.memberships, 'end').mockRejectedValueOnce(new Error('simulated'));

      await cancelCouple(app, token, couple.id).expect(500);
      const state = await stateOf(couple.id, user.id, invite.code);
      expect(state.couple?.status).toBe('pending');
      expect(state.membership?.status).toBe('active');
      expect(state.invite?.status).toBe('active');
    });

    it('rolls back couple and membership when revoking the invite fails', async () => {
      const { token, user, couple, invite } = await creatorWithInvite(app);
      vi.spyOn(services.invites, 'revokeActiveByCouple').mockRejectedValueOnce(
        new Error('simulated'),
      );

      await cancelCouple(app, token, couple.id).expect(500);
      const state = await stateOf(couple.id, user.id, invite.code);
      expect(state.couple?.status).toBe('pending');
      expect(state.membership?.status).toBe('active');
      expect(state.invite?.status).toBe('active');

      await cancelCouple(app, token, couple.id).expect(204);
    });
  });
});
