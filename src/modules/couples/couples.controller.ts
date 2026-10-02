import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { UserRateLimit } from '../../common/throttling/user-rate-limit.guard.js';
import { ValidationKey } from '../../common/validation/validation-keys.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CoupleSetupService } from './couple-setup.service.js';
import { COUPLE_THROTTLE, INVITE_RATE_LIMITS } from './couples.constants.js';
import { CouplesService } from './couples.service.js';
import {
  CreateCoupleDto,
  UPDATE_COUPLE_FIELDS,
  UpdateCoupleDto,
} from './dto/couple-request.dto.js';
import { CoupleDto } from './dto/couple.dto.js';
import { InviteDto } from './dto/invite.dto.js';

import type { AuthContext } from '../auth/auth-context.js';

const COUPLE_ID_PARAM = { name: 'coupleId', example: 'cpl_8Qw2LmN4pZx7Ka1B' };

@ApiTags('couples')
@ApiBearerAuth()
@Controller('couples')
export class CouplesController {
  constructor(
    private readonly couples: CouplesService,
    private readonly setup: CoupleSetupService,
  ) {}

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

  @Post(':coupleId/invite')
  @HttpCode(HttpStatus.OK)
  @UserRateLimit('inviteIssue', INVITE_RATE_LIMITS.inviteIssue)
  @ApiOperation({
    summary: 'The creator’s usable invite code (creator only, pending only)',
    description:
      'Returns the current invite while it is usable, without changing anything. Otherwise ' +
      '(none yet, or expired) issues a new one. Call it when the invite screen opens and ' +
      'when the countdown reaches zero.',
  })
  @ApiParam(COUPLE_ID_PARAM)
  @ApiOkResponse({ type: InviteDto })
  @ApiErrorResponses(401, 403, 404, 409, 429, 503)
  ensureInvite(
    @CurrentUser() auth: AuthContext,
    @Param('coupleId') coupleId: string,
  ): Promise<InviteDto> {
    return this.setup.ensureInvite(auth, coupleId);
  }

  @Post(':coupleId/invite/regenerate')
  @HttpCode(HttpStatus.OK)
  @UserRateLimit('inviteIssue', INVITE_RATE_LIMITS.inviteIssue)
  @ApiOperation({
    summary: 'Replace the invite code (creator only, pending only)',
    description:
      'Issues a new code with a fresh expiry. The previous code stops working immediately ' +
      '(INVITE_EXPIRED). Disable the button while a request is in flight.',
  })
  @ApiParam(COUPLE_ID_PARAM)
  @ApiOkResponse({ type: InviteDto })
  @ApiErrorResponses(401, 403, 404, 409, 429, 503)
  regenerateInvite(
    @CurrentUser() auth: AuthContext,
    @Param('coupleId') coupleId: string,
  ): Promise<InviteDto> {
    return this.setup.regenerateInvite(auth, coupleId);
  }

  @Post(':coupleId/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(COUPLE_THROTTLE.cancel)
  @ApiOperation({
    summary: 'Give up a pending couple (creator only)',
    description:
      'The couple and its invite stop working and the caller is free to create or join ' +
      'another couple. Afterwards GET /v1/couples/{id} is 404 and /auth/me has ' +
      '`activeCouple: null`. Not idempotent: retrying after a cancel has completed returns ' +
      '404 COUPLE_NOT_FOUND (the caller is no longer a member); a concurrent duplicate ' +
      'cancel that loses the race may instead return 409 COUPLE_NOT_PENDING.',
  })
  @ApiParam(COUPLE_ID_PARAM)
  @ApiNoContentResponse()
  @ApiErrorResponses(401, 403, 404, 409, 429)
  async cancel(
    @CurrentUser() auth: AuthContext,
    @Param('coupleId') coupleId: string,
  ): Promise<void> {
    await this.setup.cancel(auth, coupleId);
  }
}
