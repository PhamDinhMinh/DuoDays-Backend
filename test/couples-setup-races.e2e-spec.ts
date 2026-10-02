import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { expectError } from './support/auth-helpers.js';
import {
  insertPartnerMembership,
  internalIds,
  raw,
  signedInUser,
} from './support/couple-helpers.js';
import { pauseAfterFirstCall, send, watchConflicts } from './support/barrier.js';
import {
  cancelCouple,
  creatorWithInvite,
  ensureInvite,
  expireInvite,
  joinInvite,
  regenerateInvite,
} from './support/invite-helpers.js';
import { closeTestApp, createTestApp } from './support/test-app.js';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { CoupleAccessService } from '../src/modules/couples/couple-access.service.js';
import type { CoupleInvitesService } from '../src/modules/couples/couple-invites.service.js';
import type { CoupleMembershipsService } from '../src/modules/couples/couple-memberships.service.js';
import type { CouplesService } from '../src/modules/couples/couples.service.js';

/**
 * Deterministic couple-setup races. Each test lets the winner's transaction do all of its
 * real writes and holds it open just before commit (pauseAfterFirstCall on its last
 * write), starts the loser, waits until MongoDB rejects the loser's first write with a
 * write conflict (watchConflicts – proof the two transactions are serialised on a shared
 * document), then lets the winner commit. The driver retries the loser's transaction
 * against the committed state. Nothing is mocked: the conditional writes and unique
 * indexes under test are the real ones.
 */
describe('couple-setup races (write-boundary barriers)', () => {
  let app: NestExpressApplication;
  let services: {
    access: CoupleAccessService;
    couples: CouplesService;
    invites: CoupleInvitesService;
    memberships: CoupleMembershipsService;
  };

  beforeAll(async () => {
    app = await createTestApp({ throttling: false });
    const [
      { CoupleAccessService },
      { CouplesService },
      { CoupleInvitesService },
      { CoupleMembershipsService },
    ] = await Promise.all([
      import('../src/modules/couples/couple-access.service.js'),
      import('../src/modules/couples/couples.service.js'),
      import('../src/modules/couples/couple-invites.service.js'),
      import('../src/modules/couples/couple-memberships.service.js'),
    ]);
    services = {
      access: app.get(CoupleAccessService),
      couples: app.get(CouplesService),
      invites: app.get(CoupleInvitesService),
      memberships: app.get(CoupleMembershipsService),
    };
  });

  afterAll(() => closeTestApp(app));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function stateOf(couplePublicId: string) {
    const couple = await raw(app, 'couples').findOne({ publicId: couplePublicId });
    const memberships = await raw(app, 'couple_memberships')
      .find({ coupleId: couple?._id })
      .toArray();
    const invites = await raw(app, 'couple_invites').find({ coupleId: couple?._id }).toArray();
    return {
      couple,
      memberships,
      active: memberships.filter(membership => membership.status === 'active'),
      invites,
      activeInvites: invites.filter(invite => invite.status === 'active'),
    };
  }

  async function membershipsOf(userPublicId: string) {
    const { userId } = await internalIds(app, userPublicId);
    return raw(app, 'couple_memberships').find({ userId }).toArray();
  }

  async function setup() {
    const creator = await creatorWithInvite(app);
    const partner = await signedInUser(app, 'Linh');
    const { userId: creatorId } = await internalIds(app, creator.user.id);
    const { userId: partnerId } = await internalIds(app, partner.user.id);
    return { creator, partner, creatorId, partnerId };
  }

  describe('join vs regenerate', () => {
    it('A. join wins: regenerate fails with COUPLE_NOT_PENDING, no replacement invite', async () => {
      const { creator, partner, creatorId, partnerId } = await setup();
      const pause = pauseAfterFirstCall(services.memberships, 'create');
      const lock = watchConflicts(services.couples, 'lockPending');

      const join = send(joinInvite(app, partner.token, creator.invite.code));
      await pause.reached;
      const regenerate = send(regenerateInvite(app, creator.token, creator.couple.id));
      await lock.conflicted;
      pause.release();
      const [joined, regenerated] = await Promise.all([join, regenerate]);

      expect(joined.status).toBe(200);
      expect(joined.body).toMatchObject({ id: creator.couple.id, status: 'active' });
      expect(regenerated.status).toBe(409);
      expectError(regenerated.body, 'COUPLE_NOT_PENDING');
      // The loser's retry re-checked "pending" atomically and never locked the couple.
      expect(lock.outcomes).not.toContain(true);
      expect(lock.outcomes.at(-1)).toBe(false);

      const state = await stateOf(creator.couple.id);
      expect(state.couple?.status).toBe('active');
      expect(state.memberships).toHaveLength(2);
      expect(state.active.map(m => [m.role, String(m.userId)]).sort()).toEqual([
        ['creator', String(creatorId)],
        ['partner', String(partnerId)],
      ]);
      expect(state.invites).toHaveLength(1);
      expect(state.invites[0]).toMatchObject({ code: creator.invite.code, status: 'redeemed' });
      expect(state.activeInvites).toHaveLength(0);
    });

    it('B. regenerate wins: the old code is revoked, join with it fails, couple stays pending', async () => {
      const { creator, partner, creatorId } = await setup();
      const pause = pauseAfterFirstCall(services.invites, 'insert');
      const redeem = watchConflicts(services.invites, 'redeem');

      const regenerate = send(regenerateInvite(app, creator.token, creator.couple.id));
      await pause.reached;
      const join = send(joinInvite(app, partner.token, creator.invite.code));
      await redeem.conflicted;
      pause.release();
      const [regenerated, joined] = await Promise.all([regenerate, join]);

      expect(regenerated.status).toBe(200);
      const fresh = regenerated.body.code as string;
      expect(fresh).not.toBe(creator.invite.code);
      // Join's first gate is the invite: the loser gets the precise invite error.
      expect(joined.status).toBe(410);
      expectError(joined.body, 'INVITE_EXPIRED');
      expect(redeem.outcomes).not.toContain(true);
      expect(redeem.outcomes.at(-1)).toBe(false);

      const state = await stateOf(creator.couple.id);
      expect(state.couple?.status).toBe('pending');
      expect(state.active).toHaveLength(1);
      expect(state.active[0]).toMatchObject({ role: 'creator', userId: creatorId });
      expect(state.invites).toHaveLength(2);
      expect(state.invites.find(i => i.code === creator.invite.code)).toMatchObject({
        status: 'revoked',
      });
      expect(state.activeInvites.map(i => i.code)).toEqual([fresh]);
      expect(await membershipsOf(partner.user.id)).toHaveLength(0);
    });
  });

  describe('join vs cancel', () => {
    it('join wins: cancel fails with COUPLE_NOT_PENDING, the couple is active', async () => {
      const { creator, partner, creatorId, partnerId } = await setup();
      const pause = pauseAfterFirstCall(services.memberships, 'create');
      const cancelWrite = watchConflicts(services.couples, 'cancelPending');

      const join = send(joinInvite(app, partner.token, creator.invite.code));
      await pause.reached;
      const cancel = send(cancelCouple(app, creator.token, creator.couple.id));
      await cancelWrite.conflicted;
      pause.release();
      const [joined, cancelled] = await Promise.all([join, cancel]);

      expect(joined.status).toBe(200);
      expect(cancelled.status).toBe(409);
      expectError(cancelled.body, 'COUPLE_NOT_PENDING');
      expect(cancelWrite.outcomes).not.toContain(true);

      const state = await stateOf(creator.couple.id);
      expect(state.couple?.status).toBe('active');
      expect(state.memberships).toHaveLength(2);
      expect(state.active.map(m => [m.role, String(m.userId)]).sort()).toEqual([
        ['creator', String(creatorId)],
        ['partner', String(partnerId)],
      ]);
      expect(state.invites).toHaveLength(1);
      expect(state.invites[0]).toMatchObject({ status: 'redeemed', redeemedByUserId: partnerId });
    });

    it('cancel wins: join fails with INVITE_EXPIRED, the couple is cancelled', async () => {
      const { creator, partner } = await setup();
      const pause = pauseAfterFirstCall(services.invites, 'revokeActiveByCouple');
      const redeem = watchConflicts(services.invites, 'redeem');

      const cancel = send(cancelCouple(app, creator.token, creator.couple.id));
      await pause.reached;
      const join = send(joinInvite(app, partner.token, creator.invite.code));
      await redeem.conflicted;
      pause.release();
      const [cancelled, joined] = await Promise.all([cancel, join]);

      expect(cancelled.status).toBe(204);
      expect(joined.status).toBe(410);
      expectError(joined.body, 'INVITE_EXPIRED');
      expect(redeem.outcomes).not.toContain(true);

      const state = await stateOf(creator.couple.id);
      expect(state.couple?.status).toBe('cancelled');
      expect(state.active).toHaveLength(0);
      expect(state.memberships).toHaveLength(1);
      expect(state.memberships[0]).toMatchObject({ role: 'creator', status: 'left' });
      expect(state.invites).toHaveLength(1);
      expect(state.invites[0]).toMatchObject({ status: 'revoked' });
      expect(state.invites[0]).not.toHaveProperty('redeemedAt');
      expect(await membershipsOf(partner.user.id)).toHaveLength(0);
    });
  });

  describe('concurrent ensure after expiry', () => {
    it('the loser sees the winner’s replacement and returns the same code', async () => {
      const { creator } = await setup();
      await expireInvite(app, creator.invite.code);
      const pause = pauseAfterFirstCall(services.invites, 'insert');
      const lock = watchConflicts(services.couples, 'lockPending');

      const first = send(ensureInvite(app, creator.token, creator.couple.id));
      await pause.reached;
      const second = send(ensureInvite(app, creator.token, creator.couple.id));
      await lock.conflicted;
      pause.release();
      const responses = await Promise.all([first, second]);

      expect(responses.map(res => res.status)).toEqual([200, 200]);
      const [code, other] = responses.map(res => res.body.code as string);
      expect(other).toBe(code);
      expect(code).not.toBe(creator.invite.code);
      expect(responses[1].body.expiresAt).toBe(responses[0].body.expiresAt);

      const state = await stateOf(creator.couple.id);
      expect(state.invites).toHaveLength(2);
      expect(state.invites.find(i => i.code === creator.invite.code)?.status).toBe('revoked');
      expect(state.activeInvites.map(i => i.code)).toEqual([code]);
    });

    it('five unsynchronised callers converge on one replacement', async () => {
      const { creator } = await setup();
      await expireInvite(app, creator.invite.code);
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => ensureInvite(app, creator.token, creator.couple.id)),
      );
      expect(responses.map(res => res.status)).toEqual([200, 200, 200, 200, 200]);
      const codes = new Set(responses.map(res => res.body.code as string));
      expect(codes.size).toBe(1);

      const state = await stateOf(creator.couple.id);
      expect(state.invites).toHaveLength(2);
      expect(state.activeInvites.map(i => i.code)).toEqual([...codes]);
    });
  });

  describe('concurrent double cancel', () => {
    it('exactly one transition; the loser that passed the pre-check gets 409 COUPLE_NOT_PENDING', async () => {
      const { creator } = await setup();
      const pause = pauseAfterFirstCall(services.invites, 'revokeActiveByCouple');
      const cancelWrite = watchConflicts(services.couples, 'cancelPending');

      const first = send(cancelCouple(app, creator.token, creator.couple.id));
      await pause.reached;
      const second = send(cancelCouple(app, creator.token, creator.couple.id));
      await cancelWrite.conflicted;
      pause.release();
      const [won, lost] = await Promise.all([first, second]);

      expect(won.status).toBe(204);
      expect(lost.status).toBe(409);
      expectError(lost.body, 'COUPLE_NOT_PENDING');
      // One pending → cancelled match; the loser's retry matched nothing.
      expect(cancelWrite.outcomes.filter(outcome => outcome === true)).toHaveLength(1);
      expect(cancelWrite.outcomes.at(-1)).toBe(false);

      const state = await stateOf(creator.couple.id);
      expect(state.couple?.status).toBe('cancelled');
      expect(state.memberships).toHaveLength(1);
      expect(state.memberships[0]).toMatchObject({ role: 'creator', status: 'left' });
      expect(state.invites).toHaveLength(1);
      expect(state.invites[0]).toMatchObject({ status: 'revoked' });
    });

    it('unsynchronised: one 204; the loser is 409 (pre-check before the commit) or 404 (after)', async () => {
      const { creator } = await setup();
      const responses = await Promise.all([
        cancelCouple(app, creator.token, creator.couple.id),
        cancelCouple(app, creator.token, creator.couple.id),
      ]);
      const statuses = responses.map(res => res.status).sort();
      expect(statuses[0]).toBe(204);
      const lost = responses.find(res => res.status !== 204);
      expect([409, 404]).toContain(lost?.status);
      expectError(lost?.body, lost?.status === 409 ? 'COUPLE_NOT_PENDING' : 'COUPLE_NOT_FOUND');

      const state = await stateOf(creator.couple.id);
      expect(state.couple?.status).toBe('cancelled');
      expect(state.memberships).toHaveLength(1);
      expect(state.memberships[0]).toMatchObject({ status: 'left' });
      expect(state.invites[0]).toMatchObject({ status: 'revoked' });
    });
  });

  describe('creator filter on the pending-couple writes (defence in depth)', () => {
    it('a non-creator member who slips past requireCreator cannot cancel or regenerate', async () => {
      const { creator, partner } = await setup();
      // A partner membership inserted directly, and the 403 pre-check disabled: only the
      // `createdByUserId` filter in cancelPending / lockPending stands in the way.
      await insertPartnerMembership(app, creator.couple.id, partner.user.id);
      vi.spyOn(services.access, 'requireCreator').mockImplementation(() => undefined);
      const before = await stateOf(creator.couple.id);

      expectError(
        (await cancelCouple(app, partner.token, creator.couple.id).expect(409)).body,
        'COUPLE_NOT_PENDING',
      );
      expectError(
        (await regenerateInvite(app, partner.token, creator.couple.id).expect(409)).body,
        'COUPLE_NOT_PENDING',
      );
      expect(await stateOf(creator.couple.id)).toEqual(before);
    });
  });
});
