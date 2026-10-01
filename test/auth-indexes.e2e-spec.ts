import { getConnectionToken } from '@nestjs/mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

describe('Phase 1 MongoDB indexes', () => {
  let app: NestExpressApplication;
  let connection: Connection;

  beforeAll(async () => {
    app = await createTestApp({ throttling: false });
    connection = app.get<Connection>(getConnectionToken());
    // Build every registered model's indexes (what autoIndex does in development).
    await Promise.all(Object.values(connection.models).map(model => model.init()));
  });

  afterAll(() => closeTestApp(app));

  async function indexes(collection: string): Promise<IndexInfo[]> {
    return (await connection.collection(collection).indexes()) as IndexInfo[];
  }

  it('users: unique publicId and unique, partial emailNormalized', async () => {
    const found = await indexes('users');
    expect(found.map(index => index.name).sort()).toEqual([
      '_id_',
      'emailNormalized_1',
      'publicId_1',
    ]);
    expect(found.find(index => index.name === 'publicId_1')).toMatchObject({
      key: { publicId: 1 },
      unique: true,
    });
    expect(found.find(index => index.name === 'emailNormalized_1')).toMatchObject({
      key: { emailNormalized: 1 },
      unique: true,
      partialFilterExpression: { emailNormalized: { $type: 'string' } },
    });
  });

  it('auth_sessions: unique publicId, userId lookup, TTL on purgeAt – no token-hash index', async () => {
    const found = await indexes('auth_sessions');
    expect(found.map(index => index.name).sort()).toEqual([
      '_id_',
      'publicId_1',
      'purgeAt_1',
      'userId_1',
    ]);
    expect(found.find(index => index.name === 'publicId_1')).toMatchObject({ unique: true });
    expect(found.find(index => index.name === 'userId_1')?.unique).toBeFalsy();
    expect(found.find(index => index.name === 'purgeAt_1')).toMatchObject({
      key: { purgeAt: 1 },
      expireAfterSeconds: 0,
    });
  });

  it('the unique email index really rejects a raw duplicate insert', async () => {
    const users = connection.collection('users');
    const doc = {
      publicId: 'usr_IndexTest000001',
      email: 'X@y.co',
      emailNormalized: 'x@y.co',
      displayName: 'X',
    };
    await users.insertOne(doc);
    await expect(
      users.insertOne({ ...doc, publicId: 'usr_IndexTest000002', email: 'x@Y.co' }),
    ).rejects.toMatchObject({ code: 11000 });
  });
});
