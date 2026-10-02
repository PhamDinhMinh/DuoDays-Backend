import { Transform } from 'class-transformer';
import { IsDefined, IsNotEmpty, IsString, Matches, ValidateBy, ValidateIf } from 'class-validator';

import { isValidRelationshipStartDate } from '../dates/calendar-date.js';
import { ValidationKey } from './validation-keys.js';

import type { ValidationOptions } from 'class-validator';

/** Trims string input before validation. Never use on passwords. */
export function Trim(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );
}

/*
 * Length in UTF-16 code units – exactly what the app's Zod `.min()/.max()` measure. The
 * built-in MinLength/MaxLength count code points instead, so "😀😀😀😀" (length 8 in the
 * app) would fail the backend's minimum of 8.
 */

export function MinUtf16Length(min: number, options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'minUtf16Length',
      constraints: [min],
      validator: { validate: (value: unknown) => typeof value === 'string' && value.length >= min },
    },
    options,
  );
}

export function MaxUtf16Length(max: number, options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'maxUtf16Length',
      constraints: [max],
      validator: { validate: (value: unknown) => typeof value === 'string' && value.length <= max },
    },
    options,
  );
}

/** Mirrors the app's NAME_MAX_LENGTH (`personNameSchema`). */
export const PERSON_NAME_MAX_LENGTH = 50;
/** No control characters (newlines, tabs, NUL…) in a person's name. */
const NO_CONTROL_CHARS = /^[^\p{Cc}]*$/u;

interface PersonNameOptions {
  /** Field may be omitted (PATCH). `null` is still rejected as `required`. */
  optional?: boolean;
}

/**
 * A person's name as the app validates it (`personNameSchema`): trimmed, 1–50 UTF-16
 * units, no control characters. Checks run in this order and stop at the first failure:
 * required → type → empty → characters → length.
 */
export function PersonName({ optional = false }: PersonNameOptions = {}): PropertyDecorator {
  const decorators: PropertyDecorator[] = [
    Trim(),
    ...(optional ? [ValidateIf((_object: object, value: unknown) => value !== undefined)] : []),
    IsDefined({ message: ValidationKey.required }),
    IsString({ message: ValidationKey.invalid }),
    IsNotEmpty({ message: ValidationKey.required }),
    Matches(NO_CONTROL_CHARS, { message: ValidationKey.invalid }),
    MaxUtf16Length(PERSON_NAME_MAX_LENGTH, { message: ValidationKey.nameTooLong }),
  ];
  return (target, propertyKey) => {
    for (const decorate of decorators) {
      decorate(target, propertyKey);
    }
  };
}

/**
 * A relationship start date: a real `YYYY-MM-DD` day inside the globally-safe window
 * defined (and explained) in common/dates/calendar-date.ts. The value stays a string.
 */
export function IsRelationshipStartDate(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isRelationshipStartDate',
      validator: { validate: (value: unknown) => isValidRelationshipStartDate(value) },
    },
    options,
  );
}
