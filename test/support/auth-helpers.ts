import { randomUUID } from 'node:crypto';

import { getConnectionToken } from '@nestjs/mongoose';
import request from 'supertest';
import { expect } from 'vitest';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Collection, Connection } from 'mongoose';

/** A raw stored document, read without the Mongoose model (as an attacker with DB access would). */
export type RawDoc = Record<string, unknown>;

export const DEFAULT_PASSWORD = 'correct horse battery';

export interface Tokens {
  tokenType: 'Bearer';
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

export interface AuthSessionBody {
  user: { id: string; email: string; displayName: string; createdAt: string };
  tokens: Tokens;
}

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}.${randomUUID().slice(0, 8)}@example.com`;
}

export function http(app: NestExpressApplication) {
  return request(app.getHttpServer());
}

export async function register(
  app: NestExpressApplication,
  overrides: Partial<{ displayName: string; email: string; password: string }> = {},
): Promise<AuthSessionBody & { password: string }> {
  const body = {
    displayName: 'Minh',
    email: uniqueEmail(),
    password: DEFAULT_PASSWORD,
    ...overrides,
  };
  const res = await http(app).post('/v1/auth/register').send(body).expect(201);
  return { ...(res.body as AuthSessionBody), password: body.password };
}

export async function login(
  app: NestExpressApplication,
  email: string,
  password: string,
): Promise<AuthSessionBody> {
  const res = await http(app).post('/v1/auth/login').send({ email, password }).expect(200);
  return res.body as AuthSessionBody;
}

export function refresh(app: NestExpressApplication, refreshToken: string) {
  return http(app).post('/v1/auth/refresh').send({ refreshToken });
}

export function me(app: NestExpressApplication, accessToken: string) {
  return http(app).get('/v1/auth/me').set('authorization', `Bearer ${accessToken}`);
}

export function collection(
  app: NestExpressApplication,
  name: 'users' | 'auth_sessions',
): Collection<RawDoc> {
  return app.get<Connection>(getConnectionToken()).collection(name);
}

export function sessionIdOf(refreshToken: string): string {
  return refreshToken.split('.')[0];
}

export function sessionDoc(app: NestExpressApplication, refreshToken: string) {
  return collection(app, 'auth_sessions').findOne({ publicId: sessionIdOf(refreshToken) });
}

/** Direct DB edit for time-based cases (expiry, grace window) – no fake clocks needed. */
export async function patchSession(
  app: NestExpressApplication,
  refreshToken: string,
  set: Record<string, unknown>,
): Promise<void> {
  const result = await collection(app, 'auth_sessions').updateOne(
    { publicId: sessionIdOf(refreshToken) },
    { $set: set },
  );
  expect(result.matchedCount).toBe(1);
}

export function expectError(body: unknown, code: string): void {
  expect(body).toMatchObject({ error: { code } });
}
