import { HttpStatus, ValidationPipe } from '@nestjs/common';

import { AppException } from '../errors/app.exception.js';
import { ErrorCode } from '../errors/error-codes.js';
import { isValidationKey, ValidationKey } from './validation-keys.js';

import type { ValidationError } from '@nestjs/common';
import type { ErrorDetail } from '../errors/error-response.js';

/** class-validator constraint names that mean "the value is missing". */
const REQUIRED_CONSTRAINTS = new Set(['isDefined', 'isNotEmpty']);

/**
 * Flattens class-validator errors into `{ field, code }` pairs – one per field, because the
 * pipe stops at the first failed rule, matching the app's "first issue per field" forms.
 */
export function toErrorDetails(errors: ValidationError[], parentPath = ''): ErrorDetail[] {
  return errors.flatMap(error => {
    const field = parentPath ? `${parentPath}.${error.property}` : error.property;
    const own = error.constraints ? [{ field, code: codeFor(error.constraints) }] : [];
    return [...own, ...toErrorDetails(error.children ?? [], field)];
  });
}

function codeFor(constraints: Record<string, string>): ValidationKey {
  const [name, message] = Object.entries(constraints)[0] ?? [];
  if (name === 'whitelistValidation') {
    return ValidationKey.unknownField;
  }
  if (isValidationKey(message)) {
    return message;
  }
  if (name && REQUIRED_CONSTRAINTS.has(name)) {
    return ValidationKey.required;
  }
  return ValidationKey.invalid;
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    stopAtFirstError: true,
    // Error details carry codes only – never echo submitted values (passwords, tokens).
    validationError: { target: false, value: false },
    exceptionFactory: errors =>
      new AppException(
        ErrorCode.VALIDATION_FAILED,
        HttpStatus.BAD_REQUEST,
        'Request validation failed.',
        toErrorDetails(errors),
      ),
  });
}
