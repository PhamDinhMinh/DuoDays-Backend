import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { expectError } from './support/auth-helpers.js';
import { signedInUser } from './support/couple-helpers.js';
import { lookupInvite } from './support/invite-helpers.js';
import { captureLogs, closeTestApp, createTestApp } from './support/test-app.js';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { CoupleInvitesService } from '../src/modules/couples/couple-invites.service.js';
import type { LogCapture } from './support/test-app.js';

const CODE = '482913';
const ERRMSG = `E11000 duplicate key error collection: t.couple_invites index: code_1 dup key: { code: "${CODE}" }`;

/** Every string value anywhere in a parsed log line (keys included). */
function strings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(strings);
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, inner]) => [key, ...strings(inner)]);
  }
  return [];
}

/**
 * Defence in depth: a duplicate-key error that escapes a service (a bug) reaches the global
 * exception filter, whose log line must not repeat the duplicated value – here an invite
 * code, carried in the error's message, stack, `errmsg` and `keyValue`.
 */
describe('a duplicate-key error reaching the exception filter never logs the value', () => {
  let app: NestExpressApplication;
  let logs: LogCapture;
  let invites: CoupleInvitesService;

  beforeAll(async () => {
    logs = captureLogs();
    app = await createTestApp({ throttling: false, env: { LOG_LEVEL: 'info' }, logs });
    const { CoupleInvitesService } =
      await import('../src/modules/couples/couple-invites.service.js');
    invites = app.get(CoupleInvitesService);
  });

  afterAll(() => closeTestApp(app));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function filterLine(msg: string) {
    return logs.lines().find(line => line.context === 'ExceptionFilter' && line.msg === msg);
  }

  function expectCodeNowhere() {
    for (const line of logs.lines()) {
      for (const value of strings(line)) {
        expect(value).not.toContain(CODE);
      }
    }
  }

  it('MongoServerError (409 backstop): logged by class, code and key pattern only', async () => {
    const duplicate = new mongoose.mongo.MongoServerError({
      message: ERRMSG,
      errmsg: ERRMSG,
      code: 11000,
      index: 0,
      keyPattern: { code: 1 },
      keyValue: { code: CODE },
    });
    // The synthetic error really carries the code where a real one does.
    expect(duplicate.message).toContain(CODE);
    expect(duplicate.keyValue).toEqual({ code: CODE });
    vi.spyOn(invites, 'findByCode').mockRejectedValueOnce(duplicate);
    const user = await signedInUser(app);

    const res = await lookupInvite(app, user.token, CODE).expect(409);
    expectError(res.body, 'CONFLICT');
    expect(JSON.stringify(res.body)).not.toContain(CODE);

    expect(filterLine('Duplicate key reached the exception filter')).toMatchObject({
      err: { type: 'MongoServerError', code: 11000, keyPattern: { code: 1 } },
    });
    expectCodeNowhere();
  });

  it('any other error class with code 11000 (500 path) is reduced the same way', async () => {
    const bulk = Object.assign(new Error(ERRMSG), {
      name: 'MongoBulkWriteError',
      code: 11000,
      keyPattern: { code: 1 },
      keyValue: { code: CODE },
      writeErrors: [{ index: 0, code: 11000, errmsg: ERRMSG, keyValue: { code: CODE } }],
    });
    vi.spyOn(invites, 'findByCode').mockRejectedValueOnce(bulk);
    const user = await signedInUser(app);

    const res = await lookupInvite(app, user.token, CODE).expect(500);
    expectError(res.body, 'INTERNAL');

    expect(filterLine('Unhandled error')).toMatchObject({
      err: { type: 'MongoBulkWriteError', code: 11000, keyPattern: { code: 1 } },
    });
    expectCodeNowhere();
  });

  it('other unhandled errors keep their full diagnostics', async () => {
    vi.spyOn(invites, 'findByCode').mockRejectedValueOnce(new Error('probe: socket closed'));
    const user = await signedInUser(app);

    await lookupInvite(app, user.token, '111111').expect(500);
    const line = logs
      .lines()
      .findLast(entry => entry.context === 'ExceptionFilter' && entry.msg === 'Unhandled error');
    expect(line).toMatchObject({ err: { message: 'probe: socket closed' } });
    expect(String((line?.err as { stack?: unknown }).stack)).toContain('probe: socket closed');
  });
});
