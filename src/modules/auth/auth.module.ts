import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';

import { AppConfigService } from '../../config/app-config.service.js';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PasswordHasher } from './password/password-hasher.js';
import { AuthSession, AuthSessionSchema } from './sessions/auth-session.schema.js';
import { AuthSessionsService } from './sessions/auth-sessions.service.js';
import { ACCESS_TOKEN_ALGORITHM, AccessTokenService } from './tokens/access-token.service.js';

@Module({
  imports: [
    UsersModule,
    MongooseModule.forFeature([{ name: AuthSession.name, schema: AuthSessionSchema }]),
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        secret: config.auth.accessTokenSecret,
        signOptions: { algorithm: ACCESS_TOKEN_ALGORITHM },
        verifyOptions: { algorithms: [ACCESS_TOKEN_ALGORITHM] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthSessionsService, PasswordHasher, AccessTokenService],
  // JwtAuthGuard is registered globally (APP_GUARD) in AppModule, after the throttler.
  exports: [AccessTokenService],
})
export class AuthModule {}
