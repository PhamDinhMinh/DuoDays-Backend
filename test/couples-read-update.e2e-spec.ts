import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { collection, expectError, http, me } from './support/auth-helpers.js';
import {
  createCouple,
  getCouple,
  insertPartnerMembership,
  patchCouple,
  raw,
  signedInUser,
  userWithCouple,
} from './support/couple-helpers.js';
import { closeTestApp, createTestApp } from './support/test-app.js';

import type { NestExpressApplication } from '@nestjs/platform-express';

describe('couple reads, updates and /auth/me bootstrap', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp({ throttling: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => closeTestApp(app));

  describe('GET /v1/couples/:coupleId', () => {
    it('lets a member read their couple', async () => {
      const { token, couple } = await userWithCouple(app);
      const res = await getCouple(app, token, couple.id).expect(200);
      expect(res.body).toEqual(couple);
    });

    it('answers non-members, unknown ids and malformed ids with the same 404', async () => {
      const { couple } = await userWithCouple(app);
      const stranger = await signedInUser(app);
      const strangerWithOwnCouple = await userWithCouple(app);

      const bodies = [];
      for (const [token, id] of [
        [stranger.token, couple.id],
        [strangerWithOwnCouple.token, couple.id],
        [stranger.token, 'cpl_AAAAAAAAAAAAAAAA'],
        [stranger.token, 'not-a-couple-id'],
        [stranger.token, '507f1f77bcf86cd799439011'],
      ]) {
        const res = await getCouple(app, token, id).expect(404);
        bodies.push({ ...res.body.error, requestId: '-' });
      }
      for (const body of bodies) {
        expect(body).toEqual({
          code: 'COUPLE_NOT_FOUND',
          message: 'Couple not found.',
          requestId: '-',
        });
      }
    });

    it('requires authentication', async () => {
      const { couple } = await userWithCouple(app);
      expectError(
        (await http(app).get(`/v1/couples/${couple.id}`).expect(401)).body,
        'UNAUTHENTICATED',
      );
    });

    it('returns 401 when the caller account no longer exists', async () => {
      const { user, token, couple } = await userWithCouple(app);
      await collection(app, 'users').deleteOne({ publicId: user.id });
      expectError((await getCouple(app, token, couple.id).expect(401)).body, 'UNAUTHENTICATED');
    });
  });

  describe('deleted caller is always 401 (never a couple-level answer)', () => {
    async function deletedUser() {
      const owner = await userWithCouple(app);
      await collection(app, 'users').deleteOne({ publicId: owner.user.id });
      return owner;
    }

    it('POST /v1/couples → 401 UNAUTHENTICATED', async () => {
      const fresh = await signedInUser(app);
      const userDoc = await collection(app, 'users').findOne({ publicId: fresh.user.id });
      await collection(app, 'users').deleteOne({ _id: userDoc?._id });
      expectError((await createCouple(app, fresh.token).expect(401)).body, 'UNAUTHENTICATED');
      expect(await raw(app, 'couples').countDocuments({ createdByUserId: userDoc?._id })).toBe(0);
      expect(await raw(app, 'couple_memberships').countDocuments({ userId: userDoc?._id })).toBe(0);
    });

    it('PATCH /v1/couples/:id → 401 UNAUTHENTICATED and nothing changes', async () => {
      const { token, couple } = await deletedUser();
      const res = await patchCouple(app, token, couple.id, { startDate: '2020-01-01' }).expect(401);
      expectError(res.body, 'UNAUTHENTICATED');
      expect((await raw(app, 'couples').findOne({ publicId: couple.id }))?.startDate).toBe(
        couple.startDate,
      );
    });

    it.each(['not-a-couple-id', 'cpl_AAAAAAAAAAAAAAAA'])(
      'GET and PATCH with id %p → 401, not 404',
      async coupleId => {
        const { token } = await deletedUser();
        expectError((await getCouple(app, token, coupleId).expect(401)).body, 'UNAUTHENTICATED');
        expectError(
          (await patchCouple(app, token, coupleId, { startDate: '2020-01-01' }).expect(401)).body,
          'UNAUTHENTICATED',
        );
      },
    );

    it('lists both members creator-first with safe summaries only (partner inserted directly – Phase 3 stand-in)', async () => {
      const { user: owner, token, couple } = await userWithCouple(app);
      const partner = await signedInUser(app, 'Linh Real');
      await insertPartnerMembership(app, couple.id, partner.user.id);

      for (const reader of [token, partner.token]) {
        const res = await getCouple(app, reader, couple.id).expect(200);
        expect(res.body.members).toEqual([
          { id: owner.id, displayName: 'Minh', role: 'creator' },
          { id: partner.user.id, displayName: 'Linh Real', role: 'partner' },
        ]);
        expect(JSON.stringify(res.body)).not.toContain('@example.com');
      }
    });
  });

  describe('GET /v1/auth/me bootstrap', () => {
    it('is null before Couple Setup and a minimal summary after', async () => {
      const user = await signedInUser(app);
      expect((await me(app, user.token).expect(200)).body.activeCouple).toBeNull();

      const { token, couple } = await userWithCouple(app);
      const body = (await me(app, token).expect(200)).body;
      expect(body.activeCouple).toEqual({ id: couple.id, status: 'pending' });
      expect(Object.keys(body).sort()).toEqual(['activeCouple', 'user']);
    });

    it('ignores an ended membership: only status="left" → activeCouple null', async () => {
      const { user, token, couple } = await userWithCouple(app);
      const userDoc = await collection(app, 'users').findOne({ publicId: user.id });
      const ended = await raw(app, 'couple_memberships').updateOne(
        { userId: userDoc?._id },
        { $set: { status: 'left' } },
      );
      expect(ended.modifiedCount).toBe(1);
      expect(await raw(app, 'couple_memberships').countDocuments({ userId: userDoc?._id })).toBe(1);

      const body = (await me(app, token).expect(200)).body;
      expect(body.activeCouple).toBeNull();
      // And the ended membership no longer grants access to that couple.
      expectError((await getCouple(app, token, couple.id).expect(404)).body, 'COUPLE_NOT_FOUND');
    });

    it('reports the couple to the partner too', async () => {
      const { couple } = await userWithCouple(app);
      const partner = await signedInUser(app);
      await insertPartnerMembership(app, couple.id, partner.user.id);
      expect((await me(app, partner.token).expect(200)).body.activeCouple).toEqual({
        id: couple.id,
        status: 'pending',
      });
    });
  });

  describe('PATCH /v1/couples/:coupleId', () => {
    it('lets the creator change all fields while pending', async () => {
      const { user, token, couple } = await userWithCouple(app);
      const res = await patchCouple(app, token, couple.id, {
        ownerName: ' Minh T. ',
        partnerName: 'Linh N.',
        startDate: '2024-02-29',
      }).expect(200);
      expect(res.body).toEqual({
        ...couple,
        startDate: '2024-02-29',
        pendingPartnerName: 'Linh N.',
        members: [{ id: user.id, displayName: 'Minh T.', role: 'creator' }],
      });
      expect((await me(app, token).expect(200)).body.user.displayName).toBe('Minh T.');
    });

    it.each([
      [{ startDate: '2020-01-01' }, { startDate: '2020-01-01' }],
      [{ partnerName: 'Only Partner' }, { pendingPartnerName: 'Only Partner' }],
    ])('updates a single couple field %#', async (patch, expected) => {
      const { token, couple } = await userWithCouple(app);
      const res = await patchCouple(app, token, couple.id, patch).expect(200);
      expect(res.body).toMatchObject(expected);
    });

    it('updates only the owner name', async () => {
      const { token, couple } = await userWithCouple(app);
      const res = await patchCouple(app, token, couple.id, { ownerName: 'Renamed' }).expect(200);
      expect(res.body.members[0].displayName).toBe('Renamed');
      expect(res.body.startDate).toBe(couple.startDate);
      expect(res.body.pendingPartnerName).toBe(couple.pendingPartnerName);
    });

    it('rejects an empty body and invalid fields', async () => {
      const { token, couple } = await userWithCouple(app);
      const empty = await patchCouple(app, token, couple.id, {}).expect(400);
      expect(empty.body.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: [{ field: 'body', code: 'required' }],
      });
      for (const [body, details] of [
        [{ startDate: '2999-12-31' }, [{ field: 'startDate', code: 'invalidDate' }]],
        [{ startDate: null }, [{ field: 'startDate', code: 'required' }]],
        [{ ownerName: '' }, [{ field: 'ownerName', code: 'required' }]],
        [{ ownerName: null }, [{ field: 'ownerName', code: 'required' }]],
        [{ partnerName: 'x'.repeat(51) }, [{ field: 'partnerName', code: 'nameTooLong' }]],
        [{ status: 'active' }, [{ field: 'status', code: 'unknownField' }]],
      ] as const) {
        const res = await patchCouple(app, token, couple.id, body).expect(400);
        expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details });
      }
      expect((await getCouple(app, token, couple.id).expect(200)).body).toEqual(couple);
    });

    it('hides the couple from non-members (404, nothing changes)', async () => {
      const { token, couple } = await userWithCouple(app);
      const stranger = await signedInUser(app);
      const res = await patchCouple(app, stranger.token, couple.id, {
        startDate: '2020-01-01',
      }).expect(404);
      expectError(res.body, 'COUPLE_NOT_FOUND');
      expect((await getCouple(app, token, couple.id).expect(200)).body.startDate).toBe(
        couple.startDate,
      );
    });

    it('forbids a member who is not the creator (403)', async () => {
      const { token, couple } = await userWithCouple(app);
      const partner = await signedInUser(app);
      await insertPartnerMembership(app, couple.id, partner.user.id);
      const res = await patchCouple(app, partner.token, couple.id, {
        startDate: '2020-01-01',
      }).expect(403);
      expect(res.body.error).toMatchObject({
        code: 'FORBIDDEN',
        message: 'Only the couple’s creator can do this.',
      });
      expect((await getCouple(app, token, couple.id).expect(200)).body.startDate).toBe(
        couple.startDate,
      );
    });

    it('refuses edits once the couple is active (409 COUPLE_NOT_PENDING) – status set directly as a Phase 3 stand-in', async () => {
      const { user, token, couple } = await userWithCouple(app);
      await raw(app, 'couples').updateOne({ publicId: couple.id }, { $set: { status: 'active' } });
      for (const body of [{ startDate: '2020-01-01' }, { ownerName: 'Nope' }]) {
        const res = await patchCouple(app, token, couple.id, body).expect(409);
        expect(res.body.error).toMatchObject({
          code: 'COUPLE_NOT_PENDING',
          message: 'This couple can no longer be edited.',
        });
      }
      const after = (await getCouple(app, token, couple.id).expect(200)).body;
      expect(after).toMatchObject({ status: 'active', startDate: couple.startDate });
      expect(after.members[0]).toEqual({ id: user.id, displayName: 'Minh', role: 'creator' });
      // Active couples no longer expose the placeholder name.
      expect(after.pendingPartnerName).toBeUndefined();
    });

    it('rolls back the couple change when the owner-name update fails (same transaction)', async () => {
      const { user, token, couple } = await userWithCouple(app);
      const { UsersService } = await import('../src/modules/users/users.service.js');
      const users = app.get(UsersService);
      // Only the user write is forced to fail; the couple update runs for real inside the
      // transaction first, so the abort must undo it.
      const updateDisplayName = vi
        .spyOn(users, 'updateDisplayName')
        .mockRejectedValueOnce(new Error('simulated user update failure'));

      await patchCouple(app, token, couple.id, {
        startDate: '2020-02-02',
        partnerName: 'Changed Partner',
        ownerName: 'Changed Owner',
      }).expect(500);
      expect(updateDisplayName).toHaveBeenCalledTimes(1);
      expect(updateDisplayName.mock.calls[0][2]).toBeDefined(); // ran with the transaction session

      const stored = await raw(app, 'couples').findOne({ publicId: couple.id });
      expect(stored).toMatchObject({
        startDate: couple.startDate,
        pendingPartnerName: couple.pendingPartnerName,
        status: 'pending',
      });
      expect((await collection(app, 'users').findOne({ publicId: user.id }))?.displayName).toBe(
        'Minh',
      );
      expect((await getCouple(app, token, couple.id).expect(200)).body).toEqual(couple);
    });

    it('never moves a couple out of pending', async () => {
      const { token, couple } = await userWithCouple(app);
      await patchCouple(app, token, couple.id, { startDate: '2021-01-01' }).expect(200);
      expect((await raw(app, 'couples').findOne({ publicId: couple.id }))?.status).toBe('pending');
    });
  });
});
