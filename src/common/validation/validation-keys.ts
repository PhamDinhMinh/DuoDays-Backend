/**
 * Field-level error codes returned in `error.details[].code`. The first five mirror the
 * DuoDays app's `validationKeys` (src/utils/validation.ts) so server-side field errors
 * reuse the existing translations. DTO decorators pass these as their `message`.
 */
export const ValidationKey = {
  required: 'required',
  invalidEmail: 'invalidEmail',
  passwordTooShort: 'passwordTooShort',
  /** Backend-only so far: the app has no maximum yet. */
  passwordTooLong: 'passwordTooLong',
  nameTooLong: 'nameTooLong',
  invalidDate: 'invalidDate',
  /** Any other rule violation (wrong type, out of range, bad format…). */
  invalid: 'invalid',
  /** A property the endpoint does not accept. */
  unknownField: 'unknownField',
} as const;

export type ValidationKey = (typeof ValidationKey)[keyof typeof ValidationKey];

const knownKeys = new Set<string>(Object.values(ValidationKey));

export function isValidationKey(value: string | undefined): value is ValidationKey {
  return value !== undefined && knownKeys.has(value);
}
