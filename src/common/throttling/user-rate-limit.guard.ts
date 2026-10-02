import {
  applyDecorators,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { normalizeIp, ThrottlerStorage } from '@nestjs/throttler';

import { AppException } from '../errors/app.exception.js';
import { ErrorCode } from '../errors/error-codes.js';

import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest } from '../../modules/auth/auth-context.js';

export interface RateLimitWindow {
  limit: number;
  ttlMs: number;
}

interface BucketConfig {
  name: string;
  windows: readonly RateLimitWindow[];
}

const RATE_LIMIT_BUCKET = Symbol('RATE_LIMIT_BUCKET');

/**
 * Limits a route by caller AND by client IP, in every window of a named bucket. Routes that
 * name the same bucket share one budget (unlike @Throttle, which counts per route). Runs as
 * a route guard, i.e. after the global JwtAuthGuard, so the user is known.
 */
export function UserRateLimit(name: string, windows: readonly RateLimitWindow[]) {
  return applyDecorators(
    SetMetadata(RATE_LIMIT_BUCKET, { name, windows } satisfies BucketConfig),
    UseGuards(UserRateLimitGuard),
  );
}

/**
 * Uses the throttler's storage (in memory: correct for a single instance only, resets on
 * restart). Answers 429 RATE_LIMITED with Retry-After like the global throttler.
 */
@Injectable()
export class UserRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const bucket = this.reflector.get<BucketConfig | undefined>(
      RATE_LIMIT_BUCKET,
      context.getHandler(),
    );
    if (!bucket) {
      return true;
    }
    const http = context.switchToHttp();
    const req = http.getRequest<AuthenticatedRequest & { ip?: string }>();
    const trackers = [
      ...(req.auth ? [`user:${req.auth.userId}`] : []),
      `ip:${normalizeIp(req.ip ?? 'unknown')}`,
    ];

    for (const [index, window] of bucket.windows.entries()) {
      for (const tracker of trackers) {
        const { isBlocked, timeToBlockExpire } = await this.storage.increment(
          `rl:${bucket.name}:${index}:${tracker}`,
          window.ttlMs,
          window.limit,
          window.ttlMs,
          bucket.name,
        );
        if (isBlocked) {
          // TODO: when several windows are blocked at once this reports the first one found;
          // Retry-After should eventually reflect the window that blocks longest.
          http
            .getResponse<{ header: (name: string, value: string) => void }>()
            .header('Retry-After', String(Math.max(1, timeToBlockExpire)));
          throw new AppException(
            ErrorCode.RATE_LIMITED,
            HttpStatus.TOO_MANY_REQUESTS,
            'Too many requests. Try again later.',
          );
        }
      }
    }
    return true;
  }
}
