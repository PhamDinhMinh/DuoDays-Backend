import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ErrorCode } from './error-codes.js';

/** One field-level problem. `code` is a validation key the app can translate. */
export class ErrorDetailDto {
  @ApiProperty({ example: 'email', description: 'Dot-separated path of the offending field.' })
  field: string;

  @ApiProperty({ example: 'invalidEmail' })
  code: string;
}

export class ErrorBodyDto {
  @ApiProperty({ enum: Object.values(ErrorCode), example: ErrorCode.VALIDATION_FAILED })
  code: string;

  @ApiProperty({ example: 'Request validation failed.' })
  message: string;

  @ApiPropertyOptional({ type: [ErrorDetailDto] })
  details?: ErrorDetailDto[];

  @ApiProperty({ example: '8d6f3c1e-6c0a-4a43-9a52-2d1f4a1c9b7e' })
  requestId: string;
}

/** The only error shape the API ever returns. */
export class ErrorResponseDto {
  @ApiProperty({ type: ErrorBodyDto })
  error: ErrorBodyDto;
}

export interface ErrorDetail {
  field: string;
  code: string;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: ErrorDetail[];
    requestId: string;
  };
}
