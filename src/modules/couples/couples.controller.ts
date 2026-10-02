import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { ValidationKey } from '../../common/validation/validation-keys.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CouplesService } from './couples.service.js';
import {
  CreateCoupleDto,
  UPDATE_COUPLE_FIELDS,
  UpdateCoupleDto,
} from './dto/couple-request.dto.js';
import { CoupleDto } from './dto/couple.dto.js';

import type { AuthContext } from '../auth/auth-context.js';

const COUPLE_ID_PARAM = { name: 'coupleId', example: 'cpl_8Qw2LmN4pZx7Ka1B' };

@ApiTags('couples')
@ApiBearerAuth()
@Controller('couples')
export class CouplesController {
  constructor(private readonly couples: CouplesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create the caller’s couple space (pending until the partner joins)' })
  @ApiCreatedResponse({ type: CoupleDto })
  @ApiErrorResponses(400, 401, 409, 429)
  create(@CurrentUser() auth: AuthContext, @Body() dto: CreateCoupleDto): Promise<CoupleDto> {
    return this.couples.create(auth, dto);
  }

  @Get(':coupleId')
  @ApiOperation({ summary: 'A couple the caller belongs to' })
  @ApiParam(COUPLE_ID_PARAM)
  @ApiOkResponse({ type: CoupleDto })
  @ApiErrorResponses(401, 404, 429)
  get(@CurrentUser() auth: AuthContext, @Param('coupleId') coupleId: string): Promise<CoupleDto> {
    return this.couples.getForMember(auth, coupleId);
  }

  @Patch(':coupleId')
  @ApiOperation({ summary: 'Edit a pending couple (creator only)' })
  @ApiParam(COUPLE_ID_PARAM)
  @ApiOkResponse({ type: CoupleDto })
  @ApiErrorResponses(400, 401, 403, 404, 409, 429)
  update(
    @CurrentUser() auth: AuthContext,
    @Param('coupleId') coupleId: string,
    @Body() dto: UpdateCoupleDto,
  ): Promise<CoupleDto> {
    if (UPDATE_COUPLE_FIELDS.every(field => dto[field] === undefined)) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        HttpStatus.BAD_REQUEST,
        'Request validation failed.',
        [{ field: 'body', code: ValidationKey.required }],
      );
    }
    return this.couples.update(auth, coupleId, dto);
  }
}
