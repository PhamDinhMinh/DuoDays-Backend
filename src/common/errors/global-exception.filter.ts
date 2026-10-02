import { randomUUID } from 'node:crypto';

import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

import { AppException } from './app.exception.js';
import { ErrorCode, errorCodeForStatus } from './error-codes.js';

import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { ErrorDetail, ErrorResponse } from './error-response.js';

/** Developer-facing defaults for errors that did not come from an AppException. */
const DEFAULT_MESSAGES: Partial<Record<ErrorCode, string>> = {
  [ErrorCode.BAD_REQUEST]: 'Bad request.',
  [ErrorCode.UNAUTHENTICATED]: 'Authentication required.',
  [ErrorCode.FORBIDDEN]: 'Forbidden.',
  [ErrorCode.NOT_FOUND]: 'Resource not found.',
  [ErrorCode.METHOD_NOT_ALLOWED]: 'Method not allowed.',
  [ErrorCode.CONFLICT]: 'Resource already exists.',
  [ErrorCode.PAYLOAD_TOO_LARGE]: 'Request body is too large.',
  [ErrorCode.UNSUPPORTED_MEDIA_TYPE]: 'Unsupported media type.',
  [ErrorCode.RATE_LIMITED]: 'Too many requests. Try again later.',
  [ErrorCode.SERVICE_UNAVAILABLE]: 'Service unavailable.',
  [ErrorCode.INTERNAL]: 'Internal server error.',
};

interface Resolved {
  status: number;
  code: ErrorCode;
  message: string;
  details?: ErrorDetail[];
}

/**
 * Turns every thrown value into the standard `{ error: { code, message, details?,
 * requestId } }` body. Unknown errors become 500 INTERNAL with no internals leaked; the
 * original is logged (with the request context) instead.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<{ id?: unknown }>();
    const resolved = this.resolve(exception);

    if (resolved.status >= 500) {
      this.logger.error({ err: loggableError(exception) }, 'Unhandled error');
    }

    const body: ErrorResponse = {
      error: {
        code: resolved.code,
        message: resolved.message,
        ...(resolved.details?.length ? { details: resolved.details } : {}),
        requestId: typeof request.id === 'string' ? request.id : randomUUID(),
      },
    };
    this.adapterHost.httpAdapter.reply(http.getResponse(), body, resolved.status);
  }

  private resolve(exception: unknown): Resolved {
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    }
    if (exception instanceof HttpException) {
      return this.fromStatus(exception.getStatus());
    }
    if (isDuplicateKeyError(exception)) {
      // Backstop only: services should pre-check and throw a domain-specific code.
      this.logger.warn(
        { err: loggableError(exception) },
        'Duplicate key reached the exception filter',
      );
      return this.fromStatus(HttpStatus.CONFLICT);
    }
    const httpError = asExposedHttpError(exception);
    if (httpError) {
      // body-parser and friends (malformed JSON, body too large, bad charset).
      return this.fromStatus(httpError.status);
    }
    return this.fromStatus(HttpStatus.INTERNAL_SERVER_ERROR);
  }

  private fromStatus(status: number): Resolved {
    const code = errorCodeForStatus(status);
    return { status, code, message: DEFAULT_MESSAGES[code] ?? 'Request failed.' };
  }
}

function isDuplicateKeyError(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { name?: unknown }).name === 'MongoServerError' &&
    (value as { code?: unknown }).code === 11000
  );
}

/**
 * What the filter logs for an error. A Mongo duplicate-key error (code 11000, whatever its
 * class) repeats the duplicated value – an invite code, an email – in its message, stack,
 * `errmsg` and `keyValue`, so only its class, code and key pattern (field names) are
 * logged. Everything else is logged as is.
 */
function loggableError(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const { name, code, keyPattern } = value as Record<string, unknown>;
  return code === 11000 ? { type: name, code, keyPattern } : value;
}

/** `http-errors`-style errors that are safe to surface with their (4xx) status. */
function asExposedHttpError(value: unknown): { status: number } | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { status, statusCode, expose } = value as Record<string, unknown>;
  const code = typeof status === 'number' ? status : statusCode;
  if (expose === true && typeof code === 'number' && code >= 400 && code < 500) {
    return { status: code };
  }
  return null;
}
