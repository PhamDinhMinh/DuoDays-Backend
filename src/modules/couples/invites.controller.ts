import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { UserRateLimit } from '../../common/throttling/user-rate-limit.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CoupleSetupService } from './couple-setup.service.js';
import { INVITE_RATE_LIMITS } from './couples.constants.js';
import { CoupleDto } from './dto/couple.dto.js';
import { InviteCodeDto } from './dto/invite-request.dto.js';
import { InvitePreviewDto } from './dto/invite.dto.js';

import type { AuthContext } from '../auth/auth-context.js';

const CODE_ERRORS_DOC =
  'Errors: INVITE_NOT_FOUND (404) – no such code; INVITE_EXPIRED (410) – no longer usable, ' +
  'meaning EITHER expired OR replaced by a newer code / couple cancelled (not only ' +
  '"expiry passed"); INVITE_ALREADY_REDEEMED (409) – someone else used it; ' +
  'ALREADY_IN_COUPLE (409) – the caller already has a pending or active couple. Lookup and ' +
  'join share one per-user and per-IP rate limit.';

/** The partner's side of Couple Setup. Codes travel in the body, never in the URL. */
@ApiTags('invites')
@ApiBearerAuth()
@Controller('invites')
export class InvitesController {
  constructor(private readonly setup: CoupleSetupService) {}

  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  @UserRateLimit('inviteCode', INVITE_RATE_LIMITS.inviteCode)
  @ApiOperation({
    summary: 'Preview the couple behind an invite code',
    description: CODE_ERRORS_DOC,
  })
  @ApiOkResponse({ type: InvitePreviewDto })
  @ApiErrorResponses(400, 401, 404, 409, 410, 429)
  lookup(@CurrentUser() auth: AuthContext, @Body() dto: InviteCodeDto): Promise<InvitePreviewDto> {
    return this.setup.lookup(auth, dto.code);
  }

  @Post('join')
  @HttpCode(HttpStatus.OK)
  @UserRateLimit('inviteCode', INVITE_RATE_LIMITS.inviteCode)
  @ApiOperation({
    summary: 'Join the couple behind an invite code (activates it)',
    description:
      'Returns the now-active couple with both members. Safe to retry: repeating a join ' +
      'that already succeeded returns the same couple – but only while the redeemed invite ' +
      'is retained (about 24 hours after the join). After that, the same partner gets ' +
      `ALREADY_IN_COUPLE instead of the replayed 200. ${CODE_ERRORS_DOC}`,
  })
  @ApiOkResponse({ type: CoupleDto })
  @ApiErrorResponses(400, 401, 404, 409, 410, 429)
  join(@CurrentUser() auth: AuthContext, @Body() dto: InviteCodeDto): Promise<CoupleDto> {
    return this.setup.join(auth, dto.code);
  }
}
