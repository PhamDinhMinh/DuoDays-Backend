import { getConnectionToken } from '@nestjs/mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeTestApp, createTestApp } from './support/test-app.js';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Connection } from 'mongoose';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('HTTP foundation', () => {
  let app: NestExpressApplication;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
  });

  afterAll(() => closeTestApp(app));

  describe('/health', () => {
    it('reports ok with the database up, outside the /v1 prefix', async () => {
      const res = await http.get('/health').expect(200);
      expect(res.body).toEqual({ status: 'ok', checks: { database: 'up' } });
      await http.get('/v1/health').expect(404);
    });
  });

  describe('request ids', () => {
    it('generates one and returns it in the header', async () => {
      const res = await http.get('/v1/__probe/ok').expect(200);
      expect(res.headers['x-request-id']).toMatch(UUID);
    });

    it('reuses a safe client id in the header and in error bodies', async () => {
      const res = await http.get('/v1/nope').set('x-request-id', 'client-req-0001').expect(404);
      expect(res.headers['x-request-id']).toBe('client-req-0001');
      expect(res.body.error.requestId).toBe('client-req-0001');
    });

    it('replaces an unsafe client id', async () => {
      const res = await http.get('/v1/__probe/ok').set('x-request-id', 'bad id').expect(200);
      expect(res.headers['x-request-id']).toMatch(UUID);
    });
  });

  describe('security headers', () => {
    it('applies helmet and hides the framework', async () => {
      const res = await http.get('/health');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBeDefined();
      expect(res.headers['strict-transport-security']).toBeDefined();
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('error model', () => {
    it('unknown route → 404 NOT_FOUND in the standard shape', async () => {
      const res = await http.get('/v1/does-not-exist').expect(404);
      expect(res.body).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: 'Resource not found.',
          requestId: res.headers['x-request-id'],
        },
      });
    });

    it('unknown route outside /v1 → the same JSON 404 (never Express HTML)', async () => {
      const res = await http.get('/wp-login.php').expect(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('AppException → its status, code, message and details', async () => {
      const res = await http.get('/v1/__probe/app-error').expect(409);
      expect(res.body).toEqual({
        error: {
          code: 'CONFLICT',
          message: 'Probe conflict.',
          details: [{ field: 'probe', code: 'invalid' }],
          requestId: res.headers['x-request-id'],
        },
      });
    });

    it('unexpected error → 500 INTERNAL without internals', async () => {
      const res = await http.get('/v1/__probe/crash').expect(500);
      expect(res.body).toEqual({
        error: {
          code: 'INTERNAL',
          message: 'Internal server error.',
          requestId: res.headers['x-request-id'],
        },
      });
      expect(res.text).not.toContain('hunter2');
      expect(res.text).not.toContain('stack');
    });

    it('malformed JSON → 400 BAD_REQUEST', async () => {
      const res = await http
        .post('/v1/__probe/validate')
        .set('content-type', 'application/json')
        .send('{"email": ')
        .expect(400);
      expect(res.body.error).toMatchObject({ code: 'BAD_REQUEST', message: 'Bad request.' });
    });

    it('body over 100kb → 413 PAYLOAD_TOO_LARGE', async () => {
      const res = await http
        .post('/v1/__probe/validate')
        .send({ email: 'a@b.co', name: 'x'.repeat(110 * 1024) })
        .expect(413);
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  describe('validation', () => {
    it('accepts a valid body', async () => {
      const res = await http
        .post('/v1/__probe/validate')
        .send({ email: 'linh@example.com', name: 'Linh' })
        .expect(201);
      expect(res.body).toEqual({ received: { email: 'linh@example.com', name: 'Linh' } });
    });

    it('returns VALIDATION_FAILED with one app validation key per field', async () => {
      const res = await http.post('/v1/__probe/validate').send({}).expect(400);
      expect(res.body.error).toEqual({
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed.',
        details: [
          { field: 'email', code: 'required' },
          { field: 'name', code: 'required' },
        ],
        requestId: res.headers['x-request-id'],
      });
    });

    it('maps rule-specific keys and flags unknown fields', async () => {
      const res = await http
        .post('/v1/__probe/validate')
        .send({ email: 'not-an-email', name: 'x'.repeat(51), role: 'admin' })
        .expect(400);
      expect(res.body.error.details).toEqual([
        { field: 'role', code: 'unknownField' },
        { field: 'email', code: 'invalidEmail' },
        { field: 'name', code: 'nameTooLong' },
      ]);
    });
  });

  describe('/health with the database down', () => {
    it('returns 503 SERVICE_UNAVAILABLE', async () => {
      const isolated = await createTestApp();
      try {
        await isolated.get<Connection>(getConnectionToken()).close();
        const res = await request(isolated.getHttpServer()).get('/health').expect(503);
        expect(res.body.error).toMatchObject({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Database is unavailable.',
        });
      } finally {
        await isolated.close();
      }
    });
  });
});
