import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { closeTestApp, createTestApp } from './support/test-app.js';

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
