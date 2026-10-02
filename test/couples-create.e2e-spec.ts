import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { expectError, http, me } from './support/auth-helpers.js';
import {
  createCouple,
  internalIds,
  raw,
  signedInUser,
  userWithCouple,
  VALID_COUPLE,
} from './support/couple-helpers.js';
import { captureLogs, closeTestApp, createTestApp } from './support/test-app.js';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { CoupleBody } from './support/couple-helpers.js';
import type { LogCapture } from './support/test-app.js';

describe('POST /v1/couples', () => {
  let app: NestExpressApplication;
  let logs: LogCapture;

  beforeAll(async () => {
    logs = captureLogs();
    app = await createTestApp({ throttling: false, logs, env: { LOG_LEVEL: 'debug' } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => closeTestApp(app));

  it('creates a pending couple with the caller as creator (201)', async () => {
    const owner = await signedInUser(app, 'Old Name');
    const res = await createCouple(app, owner.token, {
      ownerName: '  Minh  ',
      partnerName: ' Linh ',
      startDate: '2025-08-28',
    }).expect(201);

    expect(res.body).toEqual({
      id: expect.stringMatching(/^cpl_[0-9A-Za-z]{16}$/),
      status: 'pending',
      startDate: '2025-08-28',
      pendingPartnerName: 'Linh',
      members: [{ id: owner.user.id, displayName: 'Minh', role: 'creator' }],
      createdAt: expect.any(String),
    });
  });

  it('writes the couple, the creator membership and the new display name together', async () => {
    const { user, token, couple } = await userWithCouple(app);
    const { userId, coupleId } = await internalIds(app, user.id, couple.id);

    expect(await raw(app, 'couples').findOne({ _id: coupleId })).toMatchObject({
      status: 'pending',
      createdByUserId: userId,
      startDate: '2025-08-28',
      pendingPartnerName: 'Linh',
    });
    const memberships = await raw(app, 'couple_memberships').find({ coupleId }).toArray();
    expect(memberships).toEqual([
      expect.objectContaining({ userId, role: 'creator', status: 'active' }),
    ]);
    expect((await me(app, token).expect(200)).body).toEqual({
      user: expect.objectContaining({ id: user.id, displayName: 'Minh' }),
      activeCouple: { id: couple.id, status: 'pending' },
    });
  });

  it('requires authentication', async () => {
    const res = await http(app).post('/v1/couples').send(VALID_COUPLE).expect(401);
    expectError(res.body, 'UNAUTHENTICATED');
  });

  it('refuses a second couple for the same user (409 ALREADY_IN_COUPLE)', async () => {
    const { token } = await userWithCouple(app);
    const res = await createCouple(app, token).expect(409);
    expect(res.body.error).toEqual({
      code: 'ALREADY_IN_COUPLE',
      message: 'You are already part of a couple.',
      requestId: res.headers['x-request-id'],
    });
  });

  it('five simultaneous creates by one user: exactly one couple and one membership', async () => {
    const owner = await signedInUser(app);
    const { userId } = await internalIds(app, owner.user.id);
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => createCouple(app, owner.token)),
    );

    expect(responses.map(res => res.status).sort()).toEqual([201, 409, 409, 409, 409]);
    for (const res of responses.filter(r => r.status === 409)) {
      expectError(res.body, 'ALREADY_IN_COUPLE');
    }
    expect(await raw(app, 'couple_memberships').countDocuments({ userId })).toBe(1);
    expect(await raw(app, 'couples').countDocuments({ createdByUserId: userId })).toBe(1);
  });

  describe('atomicity', () => {
    async function services() {
      const [{ CoupleMembershipsService }, { UsersService }] = await Promise.all([
        import('../src/modules/couples/couple-memberships.service.js'),
        import('../src/modules/users/users.service.js'),
      ]);
      return { memberships: app.get(CoupleMembershipsService), users: app.get(UsersService) };
    }

    it('rolls back the couple when the membership insert fails (index-enforced, pre-check bypassed)', async () => {
      const { user, token } = await userWithCouple(app);
      const { userId } = await internalIds(app, user.id);
      const { memberships } = await services();
      // Simulate losing the race: the pre-check sees nothing, the unique index still says no.
      vi.spyOn(memberships, 'findActiveByUser').mockResolvedValueOnce(null);

      const res = await createCouple(app, token, { ...VALID_COUPLE, ownerName: 'Changed' }).expect(
        409,
      );
      expectError(res.body, 'ALREADY_IN_COUPLE');
      expect(await raw(app, 'couples').countDocuments({ createdByUserId: userId })).toBe(1);
      expect((await raw(app, 'users').findOne({ _id: userId }))?.displayName).toBe('Minh');
    });

    it('rolls back couple and membership when the display-name update fails', async () => {
      const owner = await signedInUser(app, 'Original');
      const { userId } = await internalIds(app, owner.user.id);
      const { users } = await services();
      vi.spyOn(users, 'updateDisplayName').mockRejectedValueOnce(new Error('simulated failure'));

      await createCouple(app, owner.token).expect(500);
      expect(await raw(app, 'couples').countDocuments({ createdByUserId: userId })).toBe(0);
      expect(await raw(app, 'couple_memberships').countDocuments({ userId })).toBe(0);
      expect((await raw(app, 'users').findOne({ _id: userId }))?.displayName).toBe('Original');

      // Nothing half-created blocks a clean retry.
      await createCouple(app, owner.token).expect(201);
    });
  });

  describe('validation', () => {
    it.each([
      [
        'missing everything',
        {},
        [
          { field: 'ownerName', code: 'required' },
          { field: 'partnerName', code: 'required' },
          { field: 'startDate', code: 'required' },
        ],
      ],
      ['blank owner name', { ownerName: '   ' }, [{ field: 'ownerName', code: 'required' }]],
      [
        '51-char partner name',
        { partnerName: 'x'.repeat(51) },
        [{ field: 'partnerName', code: 'nameTooLong' }],
      ],
      ['control chars', { partnerName: 'Li\tnh' }, [{ field: 'partnerName', code: 'invalid' }]],
      ['non-string name', { ownerName: 42 }, [{ field: 'ownerName', code: 'invalid' }]],
      [
        'malformed date',
        { startDate: '28/08/2025' },
        [{ field: 'startDate', code: 'invalidDate' }],
      ],
      [
        'ISO timestamp',
        { startDate: '2025-08-28T00:00:00.000Z' },
        [{ field: 'startDate', code: 'invalidDate' }],
      ],
      [
        'impossible date',
        { startDate: '2025-02-30' },
        [{ field: 'startDate', code: 'invalidDate' }],
      ],
      [
        'Feb 29 in a non-leap year',
        { startDate: '2025-02-29' },
        [{ field: 'startDate', code: 'invalidDate' }],
      ],
      ['far future', { startDate: '2999-01-01' }, [{ field: 'startDate', code: 'invalidDate' }]],
      [
        'over 100 years ago',
        { startDate: '1900-01-01' },
        [{ field: 'startDate', code: 'invalidDate' }],
      ],
      ['number date', { startDate: 20250828 }, [{ field: 'startDate', code: 'invalidDate' }]],
      ['unknown field', { status: 'active' }, [{ field: 'status', code: 'unknownField' }]],
    ])('%s → 400', async (_case, patch, details) => {
      const { token } = await signedInUser(app);
      const body = Object.keys(patch).length === 0 ? {} : { ...VALID_COUPLE, ...patch };
      const res = await createCouple(app, token, body).expect(400);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details });
    });

    it('accepts a leap day and keeps it exactly', async () => {
      const { couple } = await userWithCouple(app, { ...VALID_COUPLE, startDate: '2024-02-29' });
      expect(couple.startDate).toBe('2024-02-29');
    });
  });

  it('never logs names or dates – only public ids', async () => {
    const owner = await signedInUser(app);
    await createCouple(app, owner.token, {
      ownerName: 'Secret Owner Name',
      partnerName: 'Secret Partner Name',
      startDate: '2011-11-11',
    }).expect(201);
    const output = logs.raw();
    for (const value of ['Secret Owner Name', 'Secret Partner Name', '2011-11-11']) {
      expect(output).not.toContain(value);
    }
    const created = logs.lines().filter(line => line.msg === 'couple.created');
    expect(created.length).toBeGreaterThan(0);
    for (const line of created) {
      expect(line).toMatchObject({
        userId: expect.stringMatching(/^usr_/),
        coupleId: expect.stringMatching(/^cpl_/),
      });
    }
  });

  it('returns only the public couple shape', async () => {
    const { couple } = await userWithCouple(app);
    const json = JSON.stringify(couple satisfies CoupleBody);
    for (const leaked of [
      '_id',
      'createdByUserId',
      'userId',
      'coupleId',
      'email',
      'password',
      'Hash',
      '__v',
    ]) {
      expect(json).not.toContain(leaked);
    }
    expect(Object.keys(couple).sort()).toEqual(
      ['createdAt', 'id', 'members', 'pendingPartnerName', 'startDate', 'status'].sort(),
    );
    expect(Object.keys(couple.members[0]).sort()).toEqual(['displayName', 'id', 'role']);
  });
});
