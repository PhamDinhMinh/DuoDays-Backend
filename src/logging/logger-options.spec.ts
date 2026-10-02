import { Writable } from 'node:stream';

import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { buildLoggerOptions, REDACTED, resolveRequestId } from './logger-options.js';

import type { IncomingMessage, ServerResponse } from 'node:http';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      raw.push(chunk.toString());
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      done();
    },
  });
  return { stream, lines, raw };
}

function fakeExchange(headers: Record<string, string>) {
  const set: Record<string, string> = {};
  const req = { headers } as unknown as IncomingMessage;
  const res = {
    setHeader: (name: string, value: string) => (set[name] = value),
  } as unknown as ServerResponse;
  return { req, res, set };
}

describe('logger redaction', () => {
  const { redact, level } = buildLoggerOptions({ level: 'info', pretty: false });

  it('redacts auth headers, cookies and sensitive fields at several depths', () => {
    const { stream, lines, raw } = capture();
    const logger = pino({ level, redact }, stream);
    logger.info(
      {
        req: {
          headers: { authorization: 'Bearer abc.def.ghi', cookie: 'sid=s3cr3t', host: 'api' },
        },
        password: 'hunter22',
        body: { refreshToken: 'rt_live_token', profile: { passwordHash: '$argon2id$xyz' } },
        config: { MONGODB_URI: 'mongodb+srv://u:p@cluster' },
      },
      'probe',
    );
    const output = raw.join('');
    for (const secret of [
      'abc.def.ghi',
      's3cr3t',
      'hunter22',
      'rt_live_token',
      '$argon2id$xyz',
      'u:p@',
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(lines[0]).toMatchObject({
      req: { headers: { authorization: REDACTED, cookie: REDACTED, host: 'api' } },
      password: REDACTED,
      body: { refreshToken: REDACTED, profile: { passwordHash: REDACTED } },
    });
  });

  it('redacts the duplicated value of a Mongo duplicate-key error', () => {
    const { stream, lines, raw } = capture();
    const errmsg = 'E11000 duplicate key error index: code_1 dup key: { code: "482913" }';
    pino({ redact }, stream).warn(
      {
        err: {
          code: 11000,
          keyPattern: { code: 1 },
          keyValue: { code: '482913' },
          errorResponse: { errmsg, keyValue: { code: '482913' } },
        },
      },
      'dup',
    );
    expect(raw.join('')).not.toContain('482913');
    expect(lines[0]).toMatchObject({
      err: {
        code: 11000,
        keyPattern: { code: 1 },
        keyValue: REDACTED,
        errorResponse: { errmsg: REDACTED, keyValue: REDACTED },
      },
    });
  });

  it('keeps ordinary fields', () => {
    const { stream, lines } = capture();
    pino({ redact }, stream).info({ code: 'INVITE_EXPIRED', userId: 'usr_x' }, 'kept');
    expect(lines[0]).toMatchObject({ code: 'INVITE_EXPIRED', userId: 'usr_x', msg: 'kept' });
  });

  it('only enables pretty printing when asked', () => {
    expect(buildLoggerOptions({ level: 'info', pretty: false }).transport).toBeUndefined();
    expect(buildLoggerOptions({ level: 'info', pretty: true }).transport).toBeDefined();
  });
});

describe('resolveRequestId', () => {
  it('reuses a safe client-supplied id and echoes it', () => {
    const { req, res, set } = fakeExchange({ 'x-request-id': 'mobile-7f3a9c21' });
    expect(resolveRequestId(req, res)).toBe('mobile-7f3a9c21');
    expect(set['x-request-id']).toBe('mobile-7f3a9c21');
  });

  it.each(['short', 'has spaces in it', 'x'.repeat(129), 'inject\nnewline-id'])(
    'replaces an unsafe id %p with a UUID',
    incoming => {
      const { req, res, set } = fakeExchange({ 'x-request-id': incoming });
      const id = resolveRequestId(req, res);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(set['x-request-id']).toBe(id);
    },
  );

  it('generates an id when none is sent', () => {
    const { req, res } = fakeExchange({});
    expect(resolveRequestId(req, res)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
