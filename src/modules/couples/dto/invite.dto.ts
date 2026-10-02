import { ApiProperty } from '@nestjs/swagger';

import type { CoupleInviteRecord } from '../couple-invite.schema.js';

/** The creator's current invite (pen 3.3). */
export class InviteDto {
  @ApiProperty({ example: '825194', description: 'Six digits. Share it; never log it.' })
  code: string;

  @ApiProperty({
    example: '2026-10-02T08:00:00.000Z',
    description: 'Server time it stops working.',
  })
  expiresAt: string;

  @ApiProperty({
    example: 86_400,
    description:
      'Seconds until expiry when the response was produced (0 once expired). Count down from ' +
      'this rather than from `expiresAt`, so device clock skew is irrelevant.',
  })
  expiresInSeconds: number;
}

/** What a partner sees before joining (pen 3.4 "Code found · Minh's space"). Nothing else. */
export class InvitePreviewDto {
  @ApiProperty({ example: 'Minh', description: 'The creator’s display name.' })
  ownerName: string;
}

export function toInviteDto(
  invite: Pick<CoupleInviteRecord, 'code' | 'expiresAt'>,
  nowMs: number = Date.now(),
): InviteDto {
  return {
    code: invite.code,
    expiresAt: invite.expiresAt.toISOString(),
    expiresInSeconds: Math.max(0, Math.floor((invite.expiresAt.getTime() - nowMs) / 1000)),
  };
}
