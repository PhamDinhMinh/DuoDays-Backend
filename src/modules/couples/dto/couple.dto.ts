import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { PUBLIC_COUPLE_STATUSES } from '../couple.schema.js';
import { MEMBERSHIP_ROLES } from '../couple-membership.schema.js';

import type { UserRecord } from '../../users/user.schema.js';
import type { CoupleRecord, PublicCoupleStatus } from '../couple.schema.js';
import type { CoupleMembershipRecord, MembershipRole } from '../couple-membership.schema.js';

/** What one partner may see about the other – no email, no account fields. */
export class CoupleMemberDto {
  @ApiProperty({ example: 'usr_3fK9aZq0LmN2pQ7x' })
  id: string;

  @ApiProperty({ example: 'Minh' })
  displayName: string;

  @ApiProperty({ enum: MEMBERSHIP_ROLES })
  role: MembershipRole;
}

export class CoupleDto {
  @ApiProperty({ example: 'cpl_8Qw2LmN4pZx7Ka1B' })
  id: string;

  @ApiProperty({ enum: PUBLIC_COUPLE_STATUSES })
  status: PublicCoupleStatus;

  @ApiProperty({ example: '2025-08-28', format: 'date' })
  startDate: string;

  @ApiPropertyOptional({ example: 'Linh', description: 'Only while pending.' })
  pendingPartnerName?: string;

  @ApiProperty({ type: [CoupleMemberDto], description: 'Creator first, then partner.' })
  members: CoupleMemberDto[];

  @ApiProperty({ example: '2026-10-01T08:00:00.000Z' })
  createdAt: string;
}

/** Bootstrap summary in GET /v1/auth/me – enough to route the app, no details. */
export class CoupleSummaryDto {
  @ApiProperty({ example: 'cpl_8Qw2LmN4pZx7Ka1B' })
  id: string;

  @ApiProperty({ enum: PUBLIC_COUPLE_STATUSES })
  status: PublicCoupleStatus;
}

/** A couple that may be shown: never `cancelled` (see isPublicCoupleStatus). */
export type VisibleCoupleRecord = CoupleRecord & { status: PublicCoupleStatus };

/** The only way a couple leaves the API – never `_id` or internal references. */
export function toCoupleDto(
  couple: VisibleCoupleRecord,
  memberships: CoupleMembershipRecord[],
  users: UserRecord[],
): CoupleDto {
  const usersById = new Map(users.map(user => [user._id.toHexString(), user]));
  const members = memberships.flatMap(membership => {
    const user = usersById.get(membership.userId.toHexString());
    return user
      ? [{ id: user.publicId, displayName: user.displayName, role: membership.role }]
      : [];
  });
  return {
    id: couple.publicId,
    status: couple.status,
    startDate: couple.startDate,
    ...(couple.status === 'pending' && couple.pendingPartnerName !== undefined
      ? { pendingPartnerName: couple.pendingPartnerName }
      : {}),
    members,
    createdAt: couple.createdAt.toISOString(),
  };
}

export function toCoupleSummaryDto(
  couple: Pick<VisibleCoupleRecord, 'publicId' | 'status'>,
): CoupleSummaryDto {
  return { id: couple.publicId, status: couple.status };
}
