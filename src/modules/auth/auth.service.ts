import { HttpStatus, Injectable, Logger } from '@nestjs/common';

import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { TransactionService } from '../../database/transaction.service.js';
import { toUserDto } from '../users/dto/user.dto.js';
import { UsersService } from '../users/users.service.js';
import { PasswordHasher } from './password/password-hasher.js';
import { AuthSessionsService } from './sessions/auth-sessions.service.js';
import { AccessTokenService } from './tokens/access-token.service.js';

import type { UserRecord } from '../users/user.schema.js';
import type { AuthContext } from './auth-context.js';
import type { LoginDto, RegisterDto } from './dto/auth-request.dto.js';
import type {
  AuthSessionDto,
  MeResponseDto,
  RefreshResponseDto,
  TokensDto,
} from './dto/auth-response.dto.js';
import type { IssuedSession } from './sessions/auth-sessions.service.js';

const emailAlreadyExists = () =>
  new AppException(
    ErrorCode.EMAIL_ALREADY_EXISTS,
    HttpStatus.CONFLICT,
    'An account with this email already exists.',
  );

const invalidCredentials = () =>
  new AppException(
    ErrorCode.INVALID_CREDENTIALS,
    HttpStatus.UNAUTHORIZED,
    'Email or password is incorrect.',
  );

const unauthenticated = () =>
  new AppException(ErrorCode.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, 'Authentication required.');

/**
 * Email/password authentication. Logs carry public ids and outcomes only – never emails,
 * passwords, tokens or hashes.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    private readonly users: UsersService,
    private readonly sessions: AuthSessionsService,
    private readonly passwords: PasswordHasher,
    private readonly accessTokens: AccessTokenService,
    private readonly transactions: TransactionService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthSessionDto> {
    if (await this.users.existsByEmail(dto.email)) {
      throw emailAlreadyExists();
    }
    // Hash outside the transaction: its callback may be retried.
    const passwordHash = await this.passwords.hash(dto.password);

    let created: { user: UserRecord; session: IssuedSession };
    try {
      created = await this.transactions.run(async dbSession => {
        const user = await this.users.createWithPassword(
          { email: dto.email, displayName: dto.displayName, passwordHash },
          dbSession,
        );
        return { user, session: await this.sessions.create(user._id, dbSession) };
      });
    } catch (error) {
      // A concurrent registration won the race for this email (unique index).
      if (isDuplicateEmailError(error)) {
        throw emailAlreadyExists();
      }
      throw error;
    }

    this.logger.log({ userId: created.user.publicId }, 'auth.registered');
    return this.toAuthSession(created.user, created.session);
  }

  async login(dto: LoginDto): Promise<AuthSessionDto> {
    const user = await this.users.findForLogin(dto.email);
    const passwordOk = user?.passwordHash
      ? await this.passwords.verify(user.passwordHash, dto.password)
      : await this.passwords.verifyDummy(dto.password);
    if (!user?.passwordHash || !passwordOk) {
      this.logger.log({ reason: 'invalid_credentials' }, 'auth.login_failed');
      throw invalidCredentials();
    }

    if (this.passwords.needsRehash(user.passwordHash)) {
      await this.upgradePasswordHash(user, dto.password);
    }
    const session = await this.sessions.create(user._id);
    this.logger.log(
      { userId: user.publicId, sessionId: session.sessionId },
      'auth.login_succeeded',
    );
    return this.toAuthSession(user, session);
  }

  async refresh(refreshToken: string): Promise<RefreshResponseDto> {
    const session = await this.sessions.rotate(refreshToken);
    const user = await this.users.findById(session.userId);
    if (!user) {
      // The account is gone; its sessions must not live on.
      await this.sessions.revokeByPublicId(session.sessionId, 'logout');
      throw new AppException(
        ErrorCode.INVALID_REFRESH_TOKEN,
        HttpStatus.UNAUTHORIZED,
        'Refresh token is invalid.',
      );
    }
    return { tokens: await this.issueTokens(user.publicId, session) };
  }

  logout(refreshToken: string): Promise<void> {
    return this.sessions.revokeByToken(refreshToken);
  }

  async me(auth: AuthContext): Promise<MeResponseDto> {
    // The guard only proved the token is genuine (no DB lookup). Whether the account still
    // exists is checked here, by the handler that needs the user.
    const user = await this.users.findByPublicId(auth.userId);
    if (!user) {
      throw unauthenticated();
    }
    return { user: toUserDto(user) };
  }

  private async toAuthSession(user: UserRecord, session: IssuedSession): Promise<AuthSessionDto> {
    return { user: toUserDto(user), tokens: await this.issueTokens(user.publicId, session) };
  }

  private async issueTokens(userId: string, session: IssuedSession): Promise<TokensDto> {
    const access = await this.accessTokens.sign({ userId, sessionId: session.sessionId });
    return {
      tokenType: 'Bearer',
      accessToken: access.token,
      accessTokenExpiresIn: access.expiresIn,
      refreshToken: session.refreshToken,
      refreshTokenExpiresAt: session.refreshTokenExpiresAt.toISOString(),
    };
  }

  /** Best effort: a failed upgrade must not fail an otherwise valid login. */
  private async upgradePasswordHash(user: UserRecord, password: string): Promise<void> {
    try {
      await this.users.updatePasswordHash(user._id, await this.passwords.hash(password));
    } catch (error) {
      this.logger.warn({ userId: user.publicId, err: error }, 'auth.password_rehash_failed');
    }
  }
}

function isDuplicateEmailError(error: unknown): boolean {
  const { code, keyPattern } = (error ?? {}) as { code?: unknown; keyPattern?: unknown };
  return (
    code === 11000 &&
    typeof keyPattern === 'object' &&
    keyPattern !== null &&
    'emailNormalized' in keyPattern
  );
}
