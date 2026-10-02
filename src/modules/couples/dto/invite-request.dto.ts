import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

import { ValidationKey } from '../../../common/validation/validation-keys.js';
import { INVITE_CODE_PATTERN } from '../invite-code.generator.js';

/**
 * The partner's typed invite code. Sent in the body – never in the URL, which request logs
 * record. Exactly six ASCII digits, not trimmed or reformatted (the app sanitizes input).
 */
export class InviteCodeDto {
  @ApiProperty({ example: '825194', pattern: '^\\d{6}$' })
  @Matches(INVITE_CODE_PATTERN, { message: ValidationKey.invalid })
  @IsString({ message: ValidationKey.invalid })
  @IsNotEmpty({ message: ValidationKey.required })
  code: string;
}
