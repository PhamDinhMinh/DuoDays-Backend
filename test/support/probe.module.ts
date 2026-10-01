import { Body, Controller, Get, HttpStatus, Logger, Module, Post } from '@nestjs/common';
import { IsDefined, IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { AppException } from '../../src/common/errors/app.exception.js';
import { ErrorCode } from '../../src/common/errors/error-codes.js';
import { ValidationKey } from '../../src/common/validation/validation-keys.js';

/*
 * Test-only routes that exercise the global infrastructure (validation, errors, logging,
 * throttling) without depending on any business module. Never imported by src/.
 */

export class ProbeDto {
  @IsEmail({}, { message: ValidationKey.invalidEmail })
  @IsNotEmpty({ message: ValidationKey.required })
  email: string;

  @MaxLength(50, { message: ValidationKey.nameTooLong })
  @IsString()
  @IsDefined({ message: ValidationKey.required })
  name: string;
}

@Controller('__probe')
class ProbeController {
  private readonly logger = new Logger('Probe');

  @Get('ok')
  ok() {
    return { ok: true };
  }

  @Post('validate')
  validate(@Body() body: ProbeDto) {
    return { received: body };
  }

  @Get('app-error')
  appError(): never {
    throw new AppException(ErrorCode.CONFLICT, HttpStatus.CONFLICT, 'Probe conflict.', [
      { field: 'probe', code: ValidationKey.invalid },
    ]);
  }

  @Get('crash')
  crash(): never {
    throw new Error('internal detail: mongodb://admin:hunter2@db');
  }

  @Post('log')
  log(@Body() body: Record<string, unknown>) {
    this.logger.log({ body }, 'probe body');
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
export class ProbeModule {}
