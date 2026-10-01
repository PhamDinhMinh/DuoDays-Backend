import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppConfigService } from './app-config.service.js';
import { validateEnv } from './env.schema.js';

/*
 * `forRoot()` reads and validates the environment as soon as this file is imported and
 * returns a promise that Nest only awaits later, while bootstrapping. Marking it handled
 * here stops an invalid environment from surfacing as an "unhandled rejection" first; Nest
 * still awaits the same promise and fails startup with the EnvValidationError.
 */
const configModule = ConfigModule.forRoot({
  cache: true,
  validate: validateEnv,
  // Tests configure the environment explicitly; a developer's .env (which points at
  // Atlas) must never leak into them.
  ignoreEnvFile: process.env.NODE_ENV === 'test',
});
configModule.catch(() => undefined);

@Global()
@Module({
  imports: [configModule],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
