import { VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

import { createValidationPipe } from './common/validation/validation.pipe.js';
import { AppConfigService } from './config/app-config.service.js';

import type { NestExpressApplication } from '@nestjs/platform-express';

/** Routes are `/v1/...` unless a controller opts out with `version: VERSION_NEUTRAL`. */
export const API_VERSION = '1';
export const SWAGGER_PATH = 'docs';
const JSON_BODY_LIMIT = '100kb';

/**
 * Everything that must be identical in production and in e2e tests: security headers,
 * body limits, URI versioning, validation and API docs. `main.ts` and the test app
 * factory both call this; the exception filter and throttler are app-module providers.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get(AppConfigService);

  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  // URI versioning rather than a global prefix: Nest's not-found handler then covers
  // every path, so unknown routes outside /v1 also get the standard error body.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_VERSION });
  app.useGlobalPipes(createValidationPipe());
  app.enableShutdownHooks();

  if (config.app.swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('DuoDays API')
        .setDescription('Backend for the DuoDays couples app.')
        .setVersion(`v${API_VERSION}`)
        .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
        .build(),
    );
    SwaggerModule.setup(SWAGGER_PATH, app, document);
  }
}
