import { getConnectionToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createCouple,
  internalIds,
  raw,
  signedInUser,
  userWithCouple,
} from './support/couple-helpers.js';
import { closeTestApp, createTestApp } from './support/test-app.js';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Connection } from 'mongoose';

interface IndexInfo {
  name: string;
  key: Record<string, number>;
  unique?: boolean;
  partialFilterExpression?: Record<string, unknown>;
}

describe('couple invariants enforced by MongoDB', () => {
  let app: NestExpressApplication;
  let connection: Connection;

  beforeAll(async () => {
    app = await createTestApp({ throttling: false });
    connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map(model => model.init()));
  });

  afterAll(() => closeTestApp(app));

  const membership = (fields: Record<string, unknown>) => ({
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...fields,
  });

  describe('indexes', () => {
    it('couples: unique publicId only', async () => {
      const found = (await connection.collection('couples').indexes()) as IndexInfo[];
      expect(found.map(index => index.name).sort()).toEqual(['_id_', 'publicId_1']);
      expect(found.find(index => index.name === 'publicId_1')).toMatchObject({ unique: true });
    });

    it('couple_memberships: partial unique userId and partial unique (coupleId, role)', async () => {
      const found = (await connection.collection('couple_memberships').indexes()) as IndexInfo[];
      expect(found.map(index => index.name).sort()).toEqual([
        '_id_',
        'coupleId_1_role_1',
        'userId_1',
      ]);
      expect(found.find(index => index.name === 'userId_1')).toMatchObject({
        key: { userId: 1 },
        unique: true,
        partialFilterExpression: { status: 'active' },
      });
      expect(found.find(index => index.name === 'coupleId_1_role_1')).toMatchObject({
        key: { coupleId: 1, role: 1 },
        unique: true,
        partialFilterExpression: { status: 'active' },
      });
    });
  });

  describe('one active couple per user (bypassing the application)', () => {
    it('rejects a second active membership for the same user', async () => {
      const userId = new Types.ObjectId();
      const memberships = raw(app, 'couple_memberships');
      await memberships.insertOne(
        membership({ userId, coupleId: new Types.ObjectId(), role: 'creator' }),
      );
      await expect(
        memberships.insertOne(
          membership({ userId, coupleId: new Types.ObjectId(), role: 'partner' }),
        ),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('ignores ended memberships (a future "left" status does not block)', async () => {
      const userId = new Types.ObjectId();
      const memberships = raw(app, 'couple_memberships');
      await memberships.insertOne(
        membership({ userId, coupleId: new Types.ObjectId(), role: 'creator', status: 'left' }),
      );
      await memberships.insertOne(
        membership({ userId, coupleId: new Types.ObjectId(), role: 'creator' }),
      );
    });
  });

  describe('at most one active creator and one active partner per couple', () => {
    it('allows creator + partner but no third member', async () => {
      const coupleId = new Types.ObjectId();
      const memberships = raw(app, 'couple_memberships');
      await memberships.insertOne(
        membership({ coupleId, userId: new Types.ObjectId(), role: 'creator' }),
      );
      await memberships.insertOne(
        membership({ coupleId, userId: new Types.ObjectId(), role: 'partner' }),
      );
      for (const role of ['creator', 'partner']) {
        await expect(
          memberships.insertOne(membership({ coupleId, userId: new Types.ObjectId(), role })),
        ).rejects.toMatchObject({ code: 11000 });
      }
      expect(await memberships.countDocuments({ coupleId, status: 'active' })).toBe(2);
    });
  });

  it('a user who is a partner elsewhere cannot create a couple', async () => {
    const { couple } = await userWithCouple(app);
    const { user, token } = await signedInUser(app);
    const { userId, coupleId } = await internalIds(app, user.id, couple.id);
    await raw(app, 'couple_memberships').insertOne(
      membership({ coupleId, userId, role: 'partner' }),
    );
    const res = await createCouple(app, token).expect(409);
    expect(res.body.error.code).toBe('ALREADY_IN_COUPLE');
  });
});
