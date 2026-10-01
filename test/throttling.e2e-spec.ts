import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeTestApp, createTestApp } from './support/test-app.js';

import type { NestExpressApplication } from '@nestjs/platform-express';

describe('global in-memory throttling', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp({ env: { THROTTLE_LIMIT: '3', THROTTLE_TTL_SECONDS: '60' } });
  });

  afterAll(() => closeTestApp(app));

  it('allows THROTTLE_LIMIT requests per window, then answers 429 RATE_LIMITED', async () => {
    const http = request(app.getHttpServer());
    for (let i = 0; i < 3; i += 1) {
      await http.get('/v1/__probe/ok').expect(200);
    }
    const res = await http.get('/v1/__probe/ok').expect(429);
    expect(res.body).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Try again later.',
        requestId: res.headers['x-request-id'],
      },
    });
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('never throttles /health', async () => {
    const http = request(app.getHttpServer());
    for (let i = 0; i < 6; i += 1) {
      await http.get('/health').expect(200);
    }
  });
});
