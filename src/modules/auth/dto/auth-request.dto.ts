import { ApiProperty } from '@nestjs/swagger';
import { IsDefined, IsEmail, IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

import { MaxUtf16Length, MinUtf16Length, Trim } from '../../../common/validation/decorators.js';
import { ValidationKey } from '../../../common/validation/validation-keys.js';
import {
  DISPLAY_NAME_MAX_LENGTH,
  EMAIL_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  REFRESH_TOKEN_MAX_LENGTH,
} from '../auth.constants.js';

/*
 * class-validator runs decorators bottom-up and stops at the first failure per field, so the
 * lowest decorator is checked first: "missing" → required, then type, then format/length.
 */

const required = { message: ValidationKey.required };
const invalid = { message: ValidationKey.invalid };
/** No control characters (newlines, tabs, NUL…) in a display name. */
const NO_CONTROL_CHARS = /^[^\p{Cc}]*$/u;

export class RegisterDto {
  @ApiProperty({ example: 'Minh', maxLength: DISPLAY_NAME_MAX_LENGTH })
  @MaxUtf16Length(DISPLAY_NAME_MAX_LENGTH, { message: ValidationKey.nameTooLong })
  @Matches(NO_CONTROL_CHARS, invalid)
  @IsNotEmpty(required)
  @IsString(invalid)
  @IsDefined(required)
  @Trim()
  displayName: string;

  @ApiProperty({ example: 'minh@example.com', maxLength: EMAIL_MAX_LENGTH })
  @IsEmail({}, { message: ValidationKey.invalidEmail })
  @MaxLength(EMAIL_MAX_LENGTH, { message: ValidationKey.invalidEmail })
  @IsNotEmpty(required)
  @IsString(invalid)
  @IsDefined(required)
  @Trim()
  email: string;

  /** Used exactly as sent: never trimmed, lowercased or Unicode-normalized. */
  @ApiProperty({
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    format: 'password',
  })
  @MaxUtf16Length(PASSWORD_MAX_LENGTH, { message: ValidationKey.passwordTooLong })
  @MinUtf16Length(PASSWORD_MIN_LENGTH, { message: ValidationKey.passwordTooShort })
  @IsNotEmpty(required)
  @IsString(invalid)
  @IsDefined(required)
  password: string;
}

export class LoginDto {
  @ApiProperty({ example: 'minh@example.com', maxLength: EMAIL_MAX_LENGTH })
  @IsEmail({}, { message: ValidationKey.invalidEmail })
  @MaxLength(EMAIL_MAX_LENGTH, { message: ValidationKey.invalidEmail })
  @IsNotEmpty(required)
  @IsString(invalid)
  @IsDefined(required)
  @Trim()
  email: string;

  /** No minimum at login – a policy change must not lock out existing passwords. */
  @ApiProperty({ maxLength: PASSWORD_MAX_LENGTH, format: 'password' })
  @MaxUtf16Length(PASSWORD_MAX_LENGTH, { message: ValidationKey.passwordTooLong })
  @IsNotEmpty(required)
  @IsString(invalid)
  @IsDefined(required)
  password: string;
}

/** Body of both /auth/refresh and /auth/logout. Its format is checked by the service. */
export class RefreshTokenDto {
  @ApiProperty({ example: 'ses_3fK9aZq0LmN2pQ7x.Qm9vZ…' })
  @MaxLength(REFRESH_TOKEN_MAX_LENGTH, invalid)
  @IsNotEmpty(required)
  @IsString(invalid)
  @IsDefined(required)
  refreshToken: string;
}
