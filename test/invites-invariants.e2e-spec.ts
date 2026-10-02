import { getConnectionToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { raw } from './support/couple-helpers.js';
import { closeTestApp, createTestApp } from './support/test-app.js';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Connection } from 'mongoose';

interface IndexInfo {
  name: string;
  key: Record<string, number>;
  unique?: boolean;
  partialFilterExpression?: Record<string, unknown>;
  expireAfterSeconds?: number;
}

/** Inserted straight into MongoDB: these hold even if every service pre-check is skipped. */
describe('invite invariants enforced by MongoDB', () => {
  let app: NestExpressApplication;
  let connection: Connection;

  beforeAll(async () => {
    app = await createTestApp({ throttling: false });
    connection = app.get<Connection>(getConnectionToken());
  });

  afterAll(() => closeTestApp(app));

  let nextCode = 300_000;
  const invite = (fields: Record<string, unknown>) => ({
    coupleId: new Types.ObjectId(),
    code: String((nextCode += 1)),
    status: 'active',
    expiresAt: new Date(Date.now() + 60_000),
    purgeAt: new Date(Date.now() + 120_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...fields,
  });

  it('couple_invites has exactly the planned indexes', async () => {
    const found = (await connection.collection('couple_invites').indexes()) as IndexInfo[];
    expect(found.map(index => index.name).sort()).toEqual([
      '_id_',
      'code_1',
      'coupleId_1',
      'purgeAt_1',
    ]);
    expect(found.find(index => index.name === 'code_1')).toMatchObject({
      key: { code: 1 },
      unique: true,
    });
    expect(found.find(index => index.name === 'code_1')).not.toHaveProperty(
      'partialFilterExpression',
    );
    expect(found.find(index => index.name === 'coupleId_1')).toMatchObject({
      key: { coupleId: 1 },
      unique: true,
      partialFilterExpression: { status: 'active' },
    });
    expect(found.find(index => index.name === 'purgeAt_1')).toMatchObject({
      key: { purgeAt: 1 },
      expireAfterSeconds: 0,
    });
  });

  it('Phase 2 indexes are unchanged', async () => {
    const couples = (await connection.collection('couples').indexes()) as IndexInfo[];
    expect(couples.map(index => index.name).sort()).toEqual(['_id_', 'publicId_1']);
    const memberships = (await connection
      .collection('couple_memberships')
      .indexes()) as IndexInfo[];
    expect(memberships.map(index => index.name).sort()).toEqual([
      '_id_',
      'coupleId_1_role_1',
      'userId_1',
    ]);
  });

  it('a code is unique across ALL invites, whatever their status', async () => {
    const invites = raw(app, 'couple_invites');
    for (const status of ['redeemed', 'revoked', 'active']) {
      const first = invite({ status });
      await invites.insertOne(first);
      await expect(invites.insertOne(invite({ code: first.code }))).rejects.toMatchObject({
        code: 11000,
      });
    }
  });

  it('at most one active invite per couple; ended invites do not count', async () => {
    const coupleId = new Types.ObjectId();
    const invites = raw(app, 'couple_invites');
    await invites.insertOne(invite({ coupleId, status: 'revoked' }));
    await invites.insertOne(invite({ coupleId, status: 'redeemed' }));
    await invites.insertOne(invite({ coupleId }));
    await expect(invites.insertOne(invite({ coupleId }))).rejects.toMatchObject({ code: 11000 });
    expect(await invites.countDocuments({ coupleId, status: 'active' })).toBe(1);
  });

  it('a "left" membership frees the user and the role (cancel relies on this)', async () => {
    const memberships = raw(app, 'couple_memberships');
    const userId = new Types.ObjectId();
    const coupleId = new Types.ObjectId();
    const base = { createdAt: new Date(), updatedAt: new Date() };
    await memberships.insertOne({ ...base, userId, coupleId, role: 'creator', status: 'left' });
    await memberships.insertOne({ ...base, userId, coupleId, role: 'creator', status: 'active' });
    await memberships.insertOne({
      ...base,
      userId,
      coupleId: new Types.ObjectId(),
      role: 'creator',
      status: 'left',
    });
  });
});
