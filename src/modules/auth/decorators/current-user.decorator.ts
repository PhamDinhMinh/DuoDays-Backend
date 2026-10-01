import { createParamDecorator, HttpStatus } from '@nestjs/common';

import { AppException } from '../../../common/errors/app.exception.js';
import { ErrorCode } from '../../../common/errors/error-codes.js';

import type { ExecutionContext } from '@nestjs/common';
import type { AuthContext, AuthenticatedRequest } from '../auth-context.js';

/**
 * The authenticated caller (`{ userId: 'usr_…', sessionId: 'ses_…' }`) on a protected route.
 * Feature services resolve the user from `userId` – never trust ids from the request body.
 */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthContext => {
    const { auth } = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!auth) {
      // Only reachable if used on a @Public() route – fail closed.
      throw new AppException(
        ErrorCode.UNAUTHENTICATED,
        HttpStatus.UNAUTHORIZED,
        'Authentication required.',
      );
    }
    return auth;
  },
);
