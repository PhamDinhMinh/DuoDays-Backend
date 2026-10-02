import { getConnectionToken } from '@nestjs/mongoose';
import { expect } from 'vitest';

import { http, register } from './auth-helpers.js';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Collection, Connection } from 'mongoose';
import type { RawDoc } from './auth-helpers.js';

export interface CoupleBody {
  id: string;
  status: 'pending' | 'active';
  startDate: string;
  pendingPartnerName?: string;
  members: { id: string; displayName: string; role: 'creator' | 'partner' }[];
  createdAt: string;
}

export const VALID_COUPLE = { ownerName: 'Minh', partnerName: 'Linh', startDate: '2025-08-28' };

/** A fresh signed-in user. */
export async function signedInUser(app: NestExpressApplication, displayName = 'Minh') {
  const { user, tokens } = await register(app, { displayName });
  return { user, token: tokens.accessToken };
}

export function createCouple(
  app: NestExpressApplication,
  token: string,
  body: Record<string, unknown> = VALID_COUPLE,
) {
  return http(app).post('/v1/couples').set('authorization', `Bearer ${token}`).send(body);
}

export function getCouple(app: NestExpressApplication, token: string, coupleId: string) {
  return http(app).get(`/v1/couples/${coupleId}`).set('authorization', `Bearer ${token}`);
}

export function patchCouple(
  app: NestExpressApplication,
  token: string,
  coupleId: string,
  body: Record<string, unknown>,
) {
  return http(app)
    .patch(`/v1/couples/${coupleId}`)
    .set('authorization', `Bearer ${token}`)
    .send(body);
}

/** A signed-in user with a freshly created pending couple. */
export async function userWithCouple(app: NestExpressApplication, body = VALID_COUPLE) {
  const owner = await signedInUser(app, body.ownerName);
  const res = await createCouple(app, owner.token, body).expect(201);
  return { ...owner, couple: res.body as CoupleBody };
}

export function raw(
  app: NestExpressApplication,
  name: 'users' | 'couples' | 'couple_memberships',
): Collection<RawDoc> {
  return app.get<Connection>(getConnectionToken()).collection(name);
}

export async function internalIds(
  app: NestExpressApplication,
  userPublicId: string,
  couplePublicId?: string,
) {
  const user = await raw(app, 'users').findOne({ publicId: userPublicId });
  const couple = couplePublicId
    ? await raw(app, 'couples').findOne({ publicId: couplePublicId })
    : null;
  expect(user).not.toBeNull();
  return { userId: user?._id, coupleId: couple?._id };
}

/**
 * Test-only shortcut standing in for Phase 3: puts `partnerPublicId` into the couple as an
 * active partner membership, directly in the database.
 */
export async function insertPartnerMembership(
  app: NestExpressApplication,
  couplePublicId: string,
  partnerPublicId: string,
): Promise<void> {
  const { userId, coupleId } = await internalIds(app, partnerPublicId, couplePublicId);
  const now = new Date();
  await raw(app, 'couple_memberships').insertOne({
    coupleId,
    userId,
    role: 'partner',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
}
