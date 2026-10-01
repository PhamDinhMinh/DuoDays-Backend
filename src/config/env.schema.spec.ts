import { describe, expect, it } from 'vitest';

import { EnvValidationError, validateEnv } from './env.schema.js';

const valid = {
  NODE_ENV: 'development',
  MONGODB_URI: 'mongodb+srv://user:pa55word@cluster0.example.mongodb.net',
  MONGODB_DB_NAME: 'duodays_dev',
};

function issuesOf(raw: Record<string, unknown>): string[] {
  try {
    validateEnv(raw);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error('expected validation to fail');
}

describe('validateEnv', () => {
  it('applies defaults and coerces types', () => {
    expect(validateEnv(valid)).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      SWAGGER_ENABLED: false,
      MONGODB_URI: valid.MONGODB_URI,
      MONGODB_DB_NAME: 'duodays_dev',
      THROTTLE_TTL_SECONDS: 60,
      THROTTLE_LIMIT: 100,
    });
  });

  it('parses explicit values', () => {
    const env = validateEnv({
      ...valid,
      PORT: '8080',
      SWAGGER_ENABLED: 'true',
      THROTTLE_LIMIT: '5',
      LOG_LEVEL: 'debug',
    });
    expect(env).toMatchObject({
      PORT: 8080,
      SWAGGER_ENABLED: true,
      THROTTLE_LIMIT: 5,
      LOG_LEVEL: 'debug',
    });
  });

  it('requires the database settings', () => {
    const issues = issuesOf({ NODE_ENV: 'development' });
    expect(issues).toContain('MONGODB_URI is required');
    expect(issues).toContain('MONGODB_DB_NAME is required');
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '70000'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'verbose'],
    ['SWAGGER_ENABLED', 'yes'],
    ['THROTTLE_LIMIT', '0'],
    ['MONGODB_DB_NAME', 'bad name!'],
  ])('rejects %s=%s', (key, value) => {
    expect(issuesOf({ ...valid, [key]: value }).some(issue => issue.startsWith(`${key} `))).toBe(
      true,
    );
  });

  it('rejects a non-MongoDB URI without echoing the value', () => {
    const secret = 'postgres://admin:topsecret@db';
    let message = '';
    try {
      validateEnv({ ...valid, MONGODB_URI: secret });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('MONGODB_URI must be a mongodb:// or mongodb+srv:// URI');
    expect(message).not.toContain('topsecret');
  });

  it('refuses an Atlas URI under NODE_ENV=test', () => {
    expect(issuesOf({ ...valid, NODE_ENV: 'test' })).toEqual([
      'MONGODB_URI must not point at an Atlas (mongodb+srv) cluster when NODE_ENV=test',
    ]);
  });

  it('accepts a plain mongodb:// URI under NODE_ENV=test', () => {
    expect(() =>
      validateEnv({ ...valid, NODE_ENV: 'test', MONGODB_URI: 'mongodb://127.0.0.1:27017' }),
    ).not.toThrow();
  });
});
