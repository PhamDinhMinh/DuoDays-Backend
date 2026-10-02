import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from './env.schema.js';

/**
 * Typed, grouped access to the validated environment. Inject this – never `process.env`
 * and never the raw `ConfigService` – so every read is checked and typed.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  get app() {
    const nodeEnv = this.get('NODE_ENV');
    return {
      nodeEnv,
      isProduction: nodeEnv === 'production',
      isDevelopment: nodeEnv === 'development',
      isTest: nodeEnv === 'test',
      port: this.get('PORT'),
      logLevel: this.get('LOG_LEVEL'),
      swaggerEnabled: this.get('SWAGGER_ENABLED'),
    };
  }

  get mongo() {
    return { uri: this.get('MONGODB_URI'), dbName: this.get('MONGODB_DB_NAME') };
  }

  get auth() {
    return {
      accessTokenSecret: this.get('JWT_ACCESS_SECRET'),
      accessTokenTtlSeconds: this.get('JWT_ACCESS_TTL'),
      issuer: this.get('JWT_ISSUER'),
      audience: this.get('JWT_AUDIENCE'),
      refreshTokenPepper: this.get('REFRESH_TOKEN_PEPPER'),
      refreshTokenTtlDays: this.get('REFRESH_TOKEN_TTL_DAYS'),
      refreshTokenAbsoluteTtlDays: this.get('REFRESH_TOKEN_ABSOLUTE_TTL_DAYS'),
    };
  }

  get couples() {
    return { inviteTtlMs: this.get('INVITE_TTL_HOURS') * 60 * 60 * 1000 };
  }

  get throttle() {
    return { ttlMs: this.get('THROTTLE_TTL_SECONDS') * 1000, limit: this.get('THROTTLE_LIMIT') };
  }
}
