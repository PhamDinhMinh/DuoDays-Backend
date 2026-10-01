import { HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppException } from '../../../common/errors/app.exception.js';
import { ErrorCode } from '../../../common/errors/error-codes.js';
import { IS_PUBLIC } from '../decorators/public.decorator.js';
import { AccessTokenService } from '../tokens/access-token.service.js';

import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth-context.js';

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;

export function extractBearerToken(header: unknown): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  return BEARER.exec(header)?.[1] ?? null;
}

/**
 * Global guard (registered after the throttler): every route needs a valid access token
 * unless marked @Public(). Every failure is the same 401 UNAUTHENTICATED – the client's
 * response (refresh once, else sign out) does not depend on why.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokens: AccessTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest & { headers: Record<string, unknown> }>();
    const token = extractBearerToken(request.headers.authorization);
    const auth = token ? await this.accessTokens.verify(token) : null;
    if (!auth) {
      throw new AppException(
        ErrorCode.UNAUTHENTICATED,
        HttpStatus.UNAUTHORIZED,
        'Authentication required.',
      );
    }
    request.auth = auth;
    return true;
  }
}
