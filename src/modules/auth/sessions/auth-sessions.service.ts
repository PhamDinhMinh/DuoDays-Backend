import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';

import { AppException } from '../../../common/errors/app.exception.js';
import { ErrorCode } from '../../../common/errors/error-codes.js';
import { createPublicId } from '../../../common/ids/public-id.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { REFRESH_REUSE_GRACE_MS, SESSION_RETENTION_MS } from '../auth.constants.js';
import { AuthSession } from './auth-session.schema.js';
import {
  formatRefreshToken,
  generateRefreshSecret,
  hashesMatch,
  hashRefreshSecret,
  parseRefreshToken,
} from './refresh-token.js';

import type { ClientSession, Model, Types } from 'mongoose';
import type { AuthSessionRecord, SessionRevokedReason } from './auth-session.schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A session plus the refresh token to hand to the client (shown once, never stored). */
export interface IssuedSession {
  sessionId: string;
  userId: Types.ObjectId;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

const invalidRefreshToken = () =>
  new AppException(
    ErrorCode.INVALID_REFRESH_TOKEN,
    HttpStatus.UNAUTHORIZED,
    'Refresh token is invalid.',
  );

/**
 * Refresh-session lifecycle. Every state change is a single conditional update on one
 * document, so rotation is atomic without a transaction: of two requests presenting the
 * same token, exactly one matches `tokenHash` and wins.
 */
@Injectable()
export class AuthSessionsService {
  private readonly logger = new Logger('Auth');

  constructor(
    @InjectModel(AuthSession.name) private readonly sessions: Model<AuthSession>,
    private readonly config: AppConfigService,
  ) {}

  async create(userId: Types.ObjectId, dbSession?: ClientSession): Promise<IssuedSession> {
    const now = Date.now();
    const absoluteExpiresAt = new Date(now + this.config.auth.refreshTokenAbsoluteTtlDays * DAY_MS);
    const expiresAt = this.idleExpiry(now, absoluteExpiresAt);
    const publicId = createPublicId('ses');
    const secret = generateRefreshSecret();

    await this.sessions.create(
      [
        {
          publicId,
          userId,
          tokenHash: this.hash(secret),
          expiresAt,
          absoluteExpiresAt,
          purgeAt: new Date(expiresAt.getTime() + SESSION_RETENTION_MS),
        },
      ],
      { session: dbSession },
    );
    return {
      sessionId: publicId,
      userId,
      refreshToken: formatRefreshToken(publicId, secret),
      refreshTokenExpiresAt: expiresAt,
    };
  }

  /**
   * Exchanges a current refresh token for a new one.
   * - current token, session live → rotated (old hash kept as `previousTokenHash`)
   * - current token, session expired → REFRESH_TOKEN_EXPIRED
   * - previous token ≤ 15 s after rotation → INVALID_REFRESH_TOKEN (benign race; no revoke)
   * - previous token later → REFRESH_TOKEN_REUSED and the session is revoked
   * - anything else (unknown secret, unknown/revoked session) → INVALID_REFRESH_TOKEN
   */
  async rotate(refreshToken: string): Promise<IssuedSession> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) {
      throw invalidRefreshToken();
    }
    const presentedHash = this.hash(parsed.secret);
    const session = await this.findByPublicId(parsed.sessionId);
    if (!session || session.revokedAt) {
      throw invalidRefreshToken();
    }

    const now = new Date();
    if (!hashesMatch(session.tokenHash, presentedHash)) {
      return this.rejectNonCurrent(session, presentedHash, now);
    }
    if (session.expiresAt <= now || session.absoluteExpiresAt <= now) {
      throw new AppException(
        ErrorCode.REFRESH_TOKEN_EXPIRED,
        HttpStatus.UNAUTHORIZED,
        'Refresh token has expired.',
      );
    }

    const secret = generateRefreshSecret();
    const expiresAt = this.idleExpiry(now.getTime(), session.absoluteExpiresAt);
    const result = await this.sessions.updateOne(
      // Compare-and-swap on the hash: only one concurrent request can match it.
      { _id: session._id, tokenHash: presentedHash, revokedAt: null },
      {
        $set: {
          tokenHash: this.hash(secret),
          previousTokenHash: presentedHash,
          lastRotatedAt: now,
          expiresAt,
          purgeAt: new Date(expiresAt.getTime() + SESSION_RETENTION_MS),
        },
        $inc: { generation: 1 },
      },
    );

    if (result.modifiedCount !== 1) {
      // Lost the race to a concurrent refresh or logout – classify against the fresh state.
      const fresh = await this.findByPublicId(parsed.sessionId);
      if (!fresh || fresh.revokedAt) {
        throw invalidRefreshToken();
      }
      return this.rejectNonCurrent(fresh, presentedHash, now);
    }

    this.logger.debug(
      { sessionId: session.publicId, generation: session.generation + 1 },
      'auth.refresh_rotated',
    );
    return {
      sessionId: session.publicId,
      userId: session.userId,
      refreshToken: formatRefreshToken(session.publicId, secret),
      refreshTokenExpiresAt: expiresAt,
    };
  }

  /**
   * Logout. Revokes the session when the token is its current or previous one; silently
   * does nothing otherwise, so the endpoint reveals nothing and knowing a session id alone
   * is never enough to end someone's session.
   */
  async revokeByToken(refreshToken: string): Promise<void> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) {
      return;
    }
    const session = await this.findByPublicId(parsed.sessionId);
    if (!session || session.revokedAt) {
      return;
    }
    const presentedHash = this.hash(parsed.secret);
    if (
      hashesMatch(session.tokenHash, presentedHash) ||
      hashesMatch(session.previousTokenHash, presentedHash)
    ) {
      await this.revoke(session._id, 'logout');
      this.logger.log({ sessionId: session.publicId }, 'auth.logout');
    }
  }

  revokeByPublicId(publicId: string, reason: SessionRevokedReason): Promise<void> {
    return this.revokeWhere({ publicId }, reason);
  }

  private revoke(id: Types.ObjectId, reason: SessionRevokedReason): Promise<void> {
    return this.revokeWhere({ _id: id }, reason);
  }

  private async revokeWhere(
    target: { _id: Types.ObjectId } | { publicId: string },
    reason: SessionRevokedReason,
  ): Promise<void> {
    const now = Date.now();
    await this.sessions.updateOne(
      { ...target, revokedAt: null },
      {
        $set: {
          revokedAt: new Date(now),
          revokedReason: reason,
          purgeAt: new Date(now + SESSION_RETENTION_MS),
        },
      },
    );
  }

  private async rejectNonCurrent(
    session: AuthSessionRecord,
    presentedHash: string,
    now: Date,
  ): Promise<never> {
    if (!hashesMatch(session.previousTokenHash, presentedHash)) {
      throw invalidRefreshToken();
    }
    const sinceRotation = now.getTime() - (session.lastRotatedAt?.getTime() ?? 0);
    if (sinceRotation <= REFRESH_REUSE_GRACE_MS) {
      // Two refreshes raced with the same token; the winner already holds the new one.
      throw invalidRefreshToken();
    }
    await this.revoke(session._id, 'reuse');
    this.logger.warn({ sessionId: session.publicId }, 'auth.refresh_reuse_detected');
    throw new AppException(
      ErrorCode.REFRESH_TOKEN_REUSED,
      HttpStatus.UNAUTHORIZED,
      'Refresh token was already used; the session has been revoked.',
    );
  }

  private findByPublicId(publicId: string): Promise<AuthSessionRecord | null> {
    return this.sessions.findOne({ publicId }).lean<AuthSessionRecord>().exec();
  }

  private idleExpiry(now: number, absoluteExpiresAt: Date): Date {
    const idle = now + this.config.auth.refreshTokenTtlDays * DAY_MS;
    return new Date(Math.min(idle, absoluteExpiresAt.getTime()));
  }

  private hash(secret: string): string {
    return hashRefreshSecret(secret, this.config.auth.refreshTokenPepper);
  }
}
