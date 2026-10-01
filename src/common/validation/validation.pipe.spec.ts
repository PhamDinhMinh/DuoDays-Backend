import 'reflect-metadata';

import { Type } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { describe, expect, it } from 'vitest';

import { AppException } from '../errors/app.exception.js';
import { createValidationPipe } from './validation.pipe.js';
import { ValidationKey } from './validation-keys.js';

class AddressDto {
  @IsString()
  city: string;
}

class SignUpDto {
  @IsEmail({}, { message: ValidationKey.invalidEmail })
  @IsNotEmpty({ message: ValidationKey.required })
  email: string;

  @MinLength(8, { message: ValidationKey.passwordTooShort })
  @IsString()
  password: string;

  @MaxLength(50, { message: ValidationKey.nameTooLong })
  @IsString()
  name: string;

  @IsOptional()
  @IsInt()
  age?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;
}

const pipe = createValidationPipe();
const metadata = { type: 'body', metatype: SignUpDto } as const;

async function detailsFor(body: unknown) {
  try {
    await pipe.transform(body, metadata);
  } catch (error) {
    expect(error).toBeInstanceOf(AppException);
    const exception = error as AppException;
    expect(exception.code).toBe('VALIDATION_FAILED');
    expect(exception.getStatus()).toBe(400);
    return exception.details;
  }
  throw new Error('expected validation to fail');
}

const validBody = { email: 'minh@example.com', password: 'longenough', name: 'Minh' };

describe('validation pipe', () => {
  it('passes and transforms a valid body', async () => {
    const result: unknown = await pipe.transform(validBody, metadata);
    expect(result).toBeInstanceOf(SignUpDto);
  });

  it('reports one code per field, "required" winning for a missing value', async () => {
    expect(await detailsFor({})).toEqual([
      { field: 'email', code: 'required' },
      { field: 'password', code: 'invalid' },
      { field: 'name', code: 'invalid' },
    ]);
  });

  it('maps rule messages to the app validation keys', async () => {
    expect(await detailsFor({ email: 'nope', password: 'short', name: 'x'.repeat(51) })).toEqual([
      { field: 'email', code: 'invalidEmail' },
      { field: 'password', code: 'passwordTooShort' },
      { field: 'name', code: 'nameTooLong' },
    ]);
  });

  it('rejects unknown properties', async () => {
    expect(await detailsFor({ ...validBody, isAdmin: true })).toEqual([
      { field: 'isAdmin', code: 'unknownField' },
    ]);
  });

  it('uses dotted paths for nested fields', async () => {
    expect(await detailsFor({ ...validBody, address: { city: 1 } })).toEqual([
      { field: 'address.city', code: 'invalid' },
    ]);
  });

  it('never includes submitted values in the error', async () => {
    try {
      await pipe.transform({ ...validBody, password: 'hunter2' }, metadata);
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('hunter2');
      expect(JSON.stringify((error as AppException).details)).not.toContain('hunter2');
      return;
    }
    throw new Error('expected validation to fail');
  });
});
