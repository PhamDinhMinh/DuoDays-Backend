import { Transform } from 'class-transformer';
import { ValidateBy } from 'class-validator';

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
