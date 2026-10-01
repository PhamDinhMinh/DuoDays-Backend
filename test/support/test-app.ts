import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import { inject, vi } from 'vitest';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Connection } from 'mongoose';

export interface TestAppOptions {
  /** Overrides on top of the test defaults; `undefined` removes a variable. */
  env?: Record<string, string | undefined>;
  /** Capture log output instead of discarding it. */
  logs?: LogCapture;
}

const ENV_KEYS = [
  'NODE_ENV',
  'PORT',
  'LOG_LEVEL',
  'SWAGGER_ENABLED',
  'MONGODB_URI',
  'MONGODB_DB_NAME',
  'THROTTLE_TTL_SECONDS',
  'THROTTLE_LIMIT',
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
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bufferLogs: true,
    bodyParser: false,
  });
  configureApp(app);
  await app.init();
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
