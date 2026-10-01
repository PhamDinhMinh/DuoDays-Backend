import request from 'supertest';
import { afterEach, describe, expect, inject, it } from 'vitest';

import {
  closeTestApp,
  createTestApp,
  TEST_JWT_SECRET,
  TEST_REFRESH_PEPPER,
} from './support/test-app.js';

import type { NestExpressApplication } from '@nestjs/platform-express';

describe('Swagger / OpenAPI', () => {
  let app: NestExpressApplication | undefined;

  afterEach(async () => {
    await closeTestApp(app);
    app = undefined;
  });

  it('serves the UI and the OpenAPI document when SWAGGER_ENABLED=true', async () => {
    app = await createTestApp({ env: { SWAGGER_ENABLED: 'true' } });
    const http = request(app.getHttpServer());

    const doc = await http.get('/docs-json').expect(200);
    expect(doc.body.openapi).toMatch(/^3\./);
    expect(doc.body.info).toMatchObject({ title: 'DuoDays API', version: 'v1' });
    expect(doc.body.paths['/health']).toBeDefined();
    expect(doc.body.components.schemas.ErrorResponseDto).toBeDefined();
    for (const path of ['register', 'login', 'refresh', 'logout', 'me']) {
      expect(doc.body.paths[`/v1/auth/${path}`]).toBeDefined();
    }
    expect(doc.body.components.securitySchemes.bearer).toMatchObject({ scheme: 'bearer' });
    expect(doc.body.paths['/v1/auth/me'].get.security).toEqual([{ bearer: [] }]);

    // No secrets, persistence-only fields or Mongoose schema classes in the public contract.
    const json = JSON.stringify(doc.body);
    for (const leaked of [
      TEST_JWT_SECRET,
      TEST_REFRESH_PEPPER,
      inject('mongoUri'),
      'passwordHash',
      'tokenHash',
      'previousTokenHash',
      '"_id"',
    ]) {
      expect(json).not.toContain(leaked);
    }
    for (const schema of ['User', 'AuthSession']) {
      expect(Object.keys(doc.body.components.schemas)).not.toContain(schema);
    }

    const ui = await http.get('/docs').expect(200);
    expect(ui.text).toContain('swagger');
  });

  it('serves nothing when SWAGGER_ENABLED=false', async () => {
    app = await createTestApp({ env: { SWAGGER_ENABLED: 'false' } });
    const http = request(app.getHttpServer());

    const res = await http.get('/docs-json').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    await http.get('/docs').expect(404);
  });
});
