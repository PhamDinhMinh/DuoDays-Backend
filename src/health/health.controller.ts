import { Controller, Get, HttpStatus, VERSION_NEUTRAL } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import mongoose from 'mongoose';

import { AppException } from '../common/errors/app.exception.js';
import { ErrorCode } from '../common/errors/error-codes.js';
import { ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';

import type { Connection } from 'mongoose';

const PING_TIMEOUT_MS = 2_000;

class HealthChecksDto {
  @ApiProperty({ enum: ['up'] })
  database: 'up';
}

export class HealthResponseDto {
  @ApiProperty({ enum: ['ok'] })
  status: 'ok';

  @ApiProperty({ type: HealthChecksDto })
  checks: HealthChecksDto;
}

/** Liveness + database reachability for the hosting platform. Not used by the app. */
@ApiTags('health')
@SkipThrottle()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Get()
  @ApiOperation({ summary: 'Service and database health' })
  @ApiOkResponse({ type: HealthResponseDto })
  @ApiErrorResponses(503)
  async check(): Promise<HealthResponseDto> {
    if (!(await this.isDatabaseUp())) {
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        HttpStatus.SERVICE_UNAVAILABLE,
        'Database is unavailable.',
      );
    }
    return { status: 'ok', checks: { database: 'up' } };
  }

  private async isDatabaseUp(): Promise<boolean> {
    const db = this.connection.db;
    if (this.connection.readyState !== mongoose.ConnectionStates.connected || !db) {
      return false;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), PING_TIMEOUT_MS);
    });
    try {
      const ping = db
        .admin()
        .ping()
        .then(() => true)
        .catch(() => false);
      return await Promise.race([ping, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
