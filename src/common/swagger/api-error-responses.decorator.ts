import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

import { ErrorResponseDto } from '../errors/error-response.js';

/** Documents the standard error body for each listed status, e.g. `@ApiErrorResponses(400, 409)`. */
export function ApiErrorResponses(...statuses: number[]) {
  return applyDecorators(
    ...statuses.map(status => ApiResponse({ status, type: ErrorResponseDto })),
  );
}
