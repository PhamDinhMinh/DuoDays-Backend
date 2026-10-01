import { HttpException } from '@nestjs/common';

import type { HttpStatus } from '@nestjs/common';
import type { ErrorCode } from './error-codes.js';
import type { ErrorDetail } from './error-response.js';

/**
 * The exception services throw for every expected failure. The global filter turns it
 * into the standard error response; nothing else should build error bodies.
 */
export class AppException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    status: HttpStatus,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message, status);
    this.name = 'AppException';
  }
}
