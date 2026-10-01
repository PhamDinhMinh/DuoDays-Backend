import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { getStorageToken } from '@nestjs/throttler';
import mongoose from 'mongoose';
import { inject, vi } from 'vitest';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Connection } from 'mongoose';

export interface TestAppOptions {
  /** Overrides on top of the test defaults; `undefined` removes a variable. */
  env?: Record<string, string | undefined>;
  /** Capture log output instead of discarding it. */
  logs?: LogCapture;
  /**
   * `false` disables rate limiting (the per-route auth limits would otherwise trip in
   * tests that create many users). Throttling tests leave it on.
   */
  throttling?: boolean;
}

/** Fixed test secrets – never real ones. */
export const TEST_JWT_SECRET = 'test-jwt-secret-0123456789abcdefghijklmnop';
export const TEST_REFRESH_PEPPER = 'test-refresh-pepper-0123456789abcdefghijkl';
export const TEST_JWT_ISSUER = 'duodays-api-test';
export const TEST_JWT_AUDIENCE = 'duodays-app-test';

const unlimitedStorage: ThrottlerStorage = {
  increment: () =>
    Promise.resolve({ totalHits: 1, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

const ENV_KEYS = [
  'NODE_ENV',
  'PORT',
  'LOG_LEVEL',
  'SWAGGER_ENABLED',
  'MONGODB_URI',
  'MONGODB_DB_NAME',
  'THROTTLE_TTL_SECONDS',
  'THROTTLE_LIMIT',
  'JWT_ACCESS_SECRET',
  'JWT_ACCESS_TTL',
  'JWT_ISSUER',
  'JWT_AUDIENCE',
  'REFRESH_TOKEN_PEPPER',
  'REFRESH_TOKEN_TTL_DAYS',
  'REFRESH_TOKEN_ABSOLUTE_TTL_DAYS',
] as const;

export function testEnv(overrides: TestAppOptions['env'] = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SWAGGER_ENABLED: 'false',
    MONGODB_URI: inject('mongoUri'),
    // One database per app instance keeps test files isolated on the shared replica set.
    MONGODB_DB_NAME: `t_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    THROTTLE_TTL_SECONDS: '60',
    THROTTLE_LIMIT: '1000',
    JWT_ACCESS_SECRET: TEST_JWT_SECRET,
    JWT_ACCESS_TTL: '15m',
    JWT_ISSUER: TEST_JWT_ISSUER,
    JWT_AUDIENCE: TEST_JWT_AUDIENCE,
    REFRESH_TOKEN_PEPPER: TEST_REFRESH_PEPPER,
    REFRESH_TOKEN_TTL_DAYS: '30',
    REFRESH_TOKEN_ABSOLUTE_TTL_DAYS: '180',
    ...overrides,
  };
}

function applyEnv(env: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * Boots the real AppModule (plus the test-only ProbeModule) configured exactly like
 * main.ts. Config is read when app.module is imported, so modules are re-imported after
 * the environment is set – every call gets a fresh, independently configured app.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<NestExpressApplication> {
  applyEnv(testEnv(options.env));
  vi.resetModules();
  const [{ AppModule }, { configureApp }, { LOG_DESTINATION }, { ProbeModule }] = await Promise.all(
    [
      import('../../src/app.module.js'),
      import('../../src/app.setup.js'),
      import('../../src/logging/logging.module.js'),
      import('./probe.module.js'),
    ],
  );

  const builder = Test.createTestingModule({ imports: [AppModule, ProbeModule] });
  if (options.logs) {
    builder.overrideProvider(LOG_DESTINATION).useValue(options.logs.stream);
  }
  if (options.throttling === false) {
    builder.overrideProvider(getStorageToken()).useValue(unlimitedStorage);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bufferLogs: true,
    bodyParser: false,
  });
  configureApp(app);
  // Listen on an ephemeral port so supertest reuses it instead of binding per request
  // (which leaks listeners under parallel requests).
  await app.listen(0, '127.0.0.1');
  return app;
}

/** Drops the app's database and shuts it down. */
export async function closeTestApp(app: NestExpressApplication | undefined): Promise<void> {
  if (!app) {
    return;
  }
  const connection = app.get<Connection>(getConnectionToken());
  if (connection.readyState === mongoose.ConnectionStates.connected) {
    await connection.dropDatabase();
  }
  await app.close();
}

export interface LogCapture {
  stream: Writable;
  lines: () => Record<string, unknown>[];
  raw: () => string;
}

export function captureLogs(): LogCapture {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  const raw = () => chunks.join('');
  const lines = () =>
    raw()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
  return { stream, lines, raw };
}
