import { Global, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { AppConfigService } from '../config/app-config.service.js';
import { buildLoggerOptions } from './logger-options.js';

import type { DestinationStream } from 'pino';

/**
 * Where log lines go. `null` means pino's default (stdout). Tests override this provider
 * with an in-memory stream to assert on what is (and is not) logged.
 */
export const LOG_DESTINATION = Symbol('LOG_DESTINATION');

@Global()
@Module({
  providers: [{ provide: LOG_DESTINATION, useValue: null }],
  exports: [LOG_DESTINATION],
})
class LogDestinationModule {}

@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [LogDestinationModule],
      inject: [AppConfigService, LOG_DESTINATION],
      useFactory: (config: AppConfigService, destination: DestinationStream | null) => {
        const options = buildLoggerOptions({
          level: config.app.logLevel,
          pretty: config.app.isDevelopment && destination === null,
        });
        return { pinoHttp: destination ? [options, destination] : options };
      },
    }),
  ],
})
export class LoggingModule {}
