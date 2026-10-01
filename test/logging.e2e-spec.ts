import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { captureLogs, closeTestApp, createTestApp } from './support/test-app.js';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { LogCapture } from './support/test-app.js';

describe('structured logging', () => {
  let app: NestExpressApplication;
  let logs: LogCapture;

  beforeAll(async () => {
    logs = captureLogs();
    app = await createTestApp({ env: { LOG_LEVEL: 'info' }, logs });
  });

  afterAll(() => closeTestApp(app));

  function requestLog(requestId: string) {
    return logs
      .lines()
      .find(
        line =>
          (line.req as { id?: string } | undefined)?.id === requestId && line.res !== undefined,
      );
  }

  it('writes one JSON line per request, tagged with the request id', async () => {
    await request(app.getHttpServer())
      .get('/v1/__probe/ok')
      .set('x-request-id', 'log-test-req-0001')
      .expect(200);

    const line = requestLog('log-test-req-0001');
    expect(line).toMatchObject({
      level: 30,
      req: { id: 'log-test-req-0001', method: 'GET', url: '/v1/__probe/ok' },
      res: { statusCode: 200 },
      msg: 'request completed',
    });
  });

  it('redacts Authorization and Cookie headers', async () => {
    await request(app.getHttpServer())
      .get('/v1/__probe/ok')
      .set('x-request-id', 'log-test-req-0002')
      .set('authorization', 'Bearer eyJhbGciOi.secret-access-token.sig')
      .set('cookie', 'session=secret-cookie-value')
      .expect(200);

    const line = requestLog('log-test-req-0002');
    expect(line).toMatchObject({
      req: { headers: { authorization: '[REDACTED]', cookie: '[REDACTED]' } },
    });
    expect(logs.raw()).not.toContain('secret-access-token');
    expect(logs.raw()).not.toContain('secret-cookie-value');
  });

  it('redacts sensitive fields in application logs and keeps the request context', async () => {
    await request(app.getHttpServer())
      .post('/v1/__probe/log')
      .set('x-request-id', 'log-test-req-0003')
      .send({
        email: 'minh@example.com',
        password: 'hunter2-password',
        refreshToken: 'rt_secret_refresh',
        social: { identityToken: 'apple-identity-secret' },
      })
      .expect(201);

    const appLine = logs.lines().find(line => line.msg === 'probe body');
    expect(appLine).toMatchObject({
      context: 'Probe',
      req: { id: 'log-test-req-0003' },
      body: {
        email: '[REDACTED]',
        password: '[REDACTED]',
        refreshToken: '[REDACTED]',
        social: { identityToken: '[REDACTED]' },
      },
    });
    for (const secret of [
      'minh@example.com',
      'hunter2-password',
      'rt_secret_refresh',
      'apple-identity-secret',
    ]) {
      expect(logs.raw()).not.toContain(secret);
    }
  });

  it('logs unexpected errors with their stack at error level, linked to the request', async () => {
    await request(app.getHttpServer())
      .get('/v1/__probe/crash')
      .set('x-request-id', 'log-test-req-0004')
      .expect(500);

    const errorLine = logs.lines().find(line => line.msg === 'Unhandled error');
    expect(errorLine).toMatchObject({ level: 50, req: { id: 'log-test-req-0004' } });
    expect((errorLine?.err as { stack?: string }).stack).toContain('internal detail');
    expect(requestLog('log-test-req-0004')).toMatchObject({ level: 50, res: { statusCode: 500 } });
  });

  it('does not log /health probes', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .set('x-request-id', 'log-test-req-0005')
      .expect(200);
    expect(requestLog('log-test-req-0005')).toBeUndefined();
  });
});
