import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { userWithCouple, signedInUser } from './support/couple-helpers.js';
import {
  cancelCouple,
  ensureInvite,
  expireInvite,
  joinInvite,
  lookupInvite,
  regenerateInvite,
  unusedCode,
} from './support/invite-helpers.js';
import { captureLogs, closeTestApp, createTestApp } from './support/test-app.js';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { LogCapture } from './support/test-app.js';

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

describe('couple-setup logging never leaks invite codes or names', () => {
  let app: NestExpressApplication;
  let logs: LogCapture;
  const codes: string[] = [];
  const ids: { creator: string; partner: string; couple: string } = {
    creator: '',
    partner: '',
    couple: '',
  };

  beforeAll(async () => {
    logs = captureLogs();
    app = await createTestApp({ throttling: false, env: { LOG_LEVEL: 'info' }, logs });

    const owner = await userWithCouple(app);
    const first = (await ensureInvite(app, owner.token, owner.couple.id).expect(200)).body;
    const second = (await regenerateInvite(app, owner.token, owner.couple.id).expect(200)).body;
    const partner = await signedInUser(app, 'Linh');
    const missing = await unusedCode(app);
    codes.push(first.code, second.code, missing);

    await lookupInvite(app, partner.token, first.code).expect(410);
    await lookupInvite(app, partner.token, missing).expect(404);
    await lookupInvite(app, partner.token, second.code).expect(200);
    await joinInvite(app, partner.token, second.code).expect(200);
    await joinInvite(app, partner.token, second.code).expect(200);

    const other = await userWithCouple(app);
    const third = (await ensureInvite(app, other.token, other.couple.id).expect(200)).body;
    await expireInvite(app, third.code);
    const fourth = (await ensureInvite(app, other.token, other.couple.id).expect(200)).body;
    codes.push(third.code, fourth.code);
    await cancelCouple(app, other.token, other.couple.id).expect(204);

    ids.creator = owner.user.id;
    ids.partner = partner.user.id;
    ids.couple = owner.couple.id;
  });

  afterAll(() => closeTestApp(app));

  it('no log value contains an invite code (request URLs included)', () => {
    const lines = logs.lines();
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      for (const value of strings(line)) {
        for (const code of codes) {
          expect(value).not.toContain(code);
        }
      }
    }
  });

  it('no names either', () => {
    expect(logs.raw()).not.toContain('Linh');
    expect(logs.raw()).not.toContain('"Minh"');
  });

  it('records the setup events with public ids and outcome categories only', () => {
    const events = logs.lines().filter(line => typeof line.msg === 'string');
    const byMsg = (msg: string) => events.filter(line => line.msg === msg);

    expect(byMsg('invite.issued').map(line => line.reason)).toEqual([
      'initial',
      'regenerate',
      'initial',
      'expired',
    ]);
    expect(byMsg('invite.lookup').map(line => line.outcome)).toEqual([
      'revoked',
      'not_found',
      'found',
    ]);
    expect(byMsg('couple.joined')).toEqual([
      expect.objectContaining({ coupleId: ids.couple, userId: ids.partner }),
    ]);
    expect(byMsg('couple.join_replayed')).toHaveLength(1);
    expect(byMsg('couple.cancelled')).toHaveLength(1);
    for (const line of [...byMsg('invite.issued'), ...byMsg('couple.joined')]) {
      expect(String(line.coupleId)).toMatch(/^cpl_/);
      expect(String(line.userId)).toMatch(/^usr_/);
    }
  });
});
