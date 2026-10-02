import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDefined, ValidateIf } from 'class-validator';

import {
  IsRelationshipStartDate,
  PERSON_NAME_MAX_LENGTH,
  PersonName,
} from '../../../common/validation/decorators.js';
import { ValidationKey } from '../../../common/validation/validation-keys.js';

const START_DATE_DOC = {
  example: '2025-08-28',
  format: 'date',
  description:
    'Calendar date (YYYY-MM-DD), Day 1 of the relationship. Not in the future and at most ' +
    '100 years ago on the user’s own calendar. Stored and returned as this exact string.',
};

/** pen 3.2 Create Couple. Mirrors the app's `PendingCoupleDetails`. */
export class CreateCoupleDto {
  @ApiProperty({
    example: 'Minh',
    maxLength: PERSON_NAME_MAX_LENGTH,
    description: 'The creator’s own name – also updates their profile display name.',
  })
  @PersonName()
  ownerName: string;

  @ApiProperty({
    example: 'Linh',
    maxLength: PERSON_NAME_MAX_LENGTH,
    description: 'Placeholder for the partner until they join with their own profile.',
  })
  @PersonName()
  partnerName: string;

  @ApiProperty(START_DATE_DOC)
  @IsRelationshipStartDate({ message: ValidationKey.invalidDate })
  @IsDefined({ message: ValidationKey.required })
  startDate: string;
}

/** Back from 3.3 → 3.2 while the couple is still pending. Send at least one field. */
export class UpdateCoupleDto {
  @ApiPropertyOptional({ example: 'Minh', maxLength: PERSON_NAME_MAX_LENGTH })
  @PersonName({ optional: true })
  ownerName?: string;

  @ApiPropertyOptional({ example: 'Linh', maxLength: PERSON_NAME_MAX_LENGTH })
  @PersonName({ optional: true })
  partnerName?: string;

  @ApiPropertyOptional(START_DATE_DOC)
  @IsRelationshipStartDate({ message: ValidationKey.invalidDate })
  @IsDefined({ message: ValidationKey.required })
  @ValidateIf((_object: object, value: unknown) => value !== undefined)
  startDate?: string;
}

export const UPDATE_COUPLE_FIELDS = ['ownerName', 'partnerName', 'startDate'] as const;
