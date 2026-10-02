import { ApiProperty } from '@nestjs/swagger';

import { CoupleSummaryDto } from '../../couples/dto/couple.dto.js';
import { UserDto } from '../../users/dto/user.dto.js';

export class TokensDto {
  @ApiProperty({ enum: ['Bearer'] })
  tokenType: 'Bearer';

  @ApiProperty({ description: 'Short-lived JWT. Send as `Authorization: Bearer <token>`.' })
  accessToken: string;

  @ApiProperty({
    example: 900,
    description:
      'Seconds until the access token expires (relative, so device clock skew is irrelevant).',
  })
  accessTokenExpiresIn: number;

  @ApiProperty({
    description:
      'Opaque, single-use. Store in the Keychain/Keystore only; replaced on every refresh.',
  })
  refreshToken: string;

  @ApiProperty({
    example: '2026-10-31T08:00:00.000Z',
    description: 'When this refresh token stops working if unused.',
  })
  refreshTokenExpiresAt: string;
}

export class AuthSessionDto {
  @ApiProperty({ type: UserDto })
  user: UserDto;

  @ApiProperty({ type: TokensDto })
  tokens: TokensDto;
}

export class RefreshResponseDto {
  @ApiProperty({ type: TokensDto })
  tokens: TokensDto;
}

export class MeResponseDto {
  @ApiProperty({ type: UserDto })
  user: UserDto;

  @ApiProperty({
    type: CoupleSummaryDto,
    nullable: true,
    description:
      'The pending/active couple, or null before Couple Setup. Details: GET /v1/couples/{id}.',
  })
  activeCouple: CoupleSummaryDto | null;
}
