import { ApiProperty } from '@nestjs/swagger';

import type { User } from '../user.schema.js';

export class UserDto {
  @ApiProperty({ example: 'usr_3fK9aZq0LmN2pQ7x' })
  id: string;

  @ApiProperty({ example: 'Minh@example.com' })
  email: string;

  @ApiProperty({ example: 'Minh' })
  displayName: string;

  @ApiProperty({ example: '2026-10-01T08:00:00.000Z' })
  createdAt: string;
}

/** The only way a user leaves the API – never `_id`, never the password hash. */
export function toUserDto(
  user: Pick<User, 'publicId' | 'email' | 'displayName' | 'createdAt'>,
): UserDto {
  return {
    id: user.publicId,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt.toISOString(),
  };
}
