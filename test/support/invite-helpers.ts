import { expect } from 'vitest';

import { http } from './auth-helpers.js';
import { raw, userWithCouple } from './couple-helpers.js';

import type { NestExpressApplication } from '@nestjs/platform-express';

export interface InviteBody {
  code: string;
  expiresAt: string;
  expiresInSeconds: number;
}

const bearer = (token: string) => ['authorization', `Bearer ${token}`] as const;

export function ensureInvite(app: NestExpressApplication, token: string, coupleId: string) {
  return http(app)
    .post(`/v1/couples/${coupleId}/invite`)
    .set(...bearer(token));
}

export function regenerateInvite(app: NestExpressApplication, token: string, coupleId: string) {
  return http(app)
    .post(`/v1/couples/${coupleId}/invite/regenerate`)
    .set(...bearer(token));
}

export function cancelCouple(app: NestExpressApplication, token: string, coupleId: string) {
  return http(app)
    .post(`/v1/couples/${coupleId}/cancel`)
    .set(...bearer(token));
}

export function lookupInvite(app: NestExpressApplication, token: string, code: unknown) {
  return http(app)
    .post('/v1/invites/lookup')
    .set(...bearer(token))
    .send({ code });
}

export function joinInvite(app: NestExpressApplication, token: string, code: unknown) {
  return http(app)
    .post('/v1/invites/join')
    .set(...bearer(token))
    .send({ code });
}

/** A signed-in creator with a pending couple and its first invite. */
export async function creatorWithInvite(app: NestExpressApplication) {
  const owner = await userWithCouple(app);
  const res = await ensureInvite(app, owner.token, owner.couple.id).expect(200);
  return { ...owner, invite: res.body as InviteBody };
}

export function inviteDoc(app: NestExpressApplication, code: string) {
  return raw(app, 'couple_invites').findOne({ code });
}

/** Direct DB edit for time-based cases – no fake clocks needed. */
export async function patchInvite(
  app: NestExpressApplication,
  code: string,
  set: Record<string, unknown>,
): Promise<void> {
  const result = await raw(app, 'couple_invites').updateOne({ code }, { $set: set });
  expect(result.matchedCount).toBe(1);
}

export function expireInvite(app: NestExpressApplication, code: string): Promise<void> {
  return patchInvite(app, code, { expiresAt: new Date(Date.now() - 1000) });
}

/** A six-digit code that is not any stored invite's code. */
export async function unusedCode(app: NestExpressApplication): Promise<string> {
  for (;;) {
    const code = String(100_000 + Math.floor(Math.random() * 900_000));
    if (!(await inviteDoc(app, code))) {
      return code;
    }
  }
}
