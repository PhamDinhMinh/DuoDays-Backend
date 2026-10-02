import { describe, expect, it } from 'vitest';

import { EnvValidationError, validateEnv } from './env.schema.js';

const valid = {
  NODE_ENV: 'development',
  MONGODB_URI: 'mongodb+srv://user:pa55word@cluster0.example.mongodb.net',
  MONGODB_DB_NAME: 'duodays_dev',
  JWT_ACCESS_SECRET: 'a'.repeat(43),
  REFRESH_TOKEN_PEPPER: 'b'.repeat(43),
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
      JWT_ACCESS_SECRET: valid.JWT_ACCESS_SECRET,
      JWT_ACCESS_TTL: 900,
      JWT_ISSUER: 'duodays-api',
      JWT_AUDIENCE: 'duodays-app',
      REFRESH_TOKEN_PEPPER: valid.REFRESH_TOKEN_PEPPER,
      REFRESH_TOKEN_TTL_DAYS: 30,
      REFRESH_TOKEN_ABSOLUTE_TTL_DAYS: 180,
      INVITE_TTL_HOURS: 24,
    });
  });

  it('parses explicit values', () => {
    const env = validateEnv({
      ...valid,
      PORT: '8080',
      SWAGGER_ENABLED: 'true',
      THROTTLE_LIMIT: '5',
      LOG_LEVEL: 'debug',
      INVITE_TTL_HOURS: '48',
    });
    expect(env).toMatchObject({
      INVITE_TTL_HOURS: 48,
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
    ['INVITE_TTL_HOURS', '0'],
    ['INVITE_TTL_HOURS', '169'],
    ['INVITE_TTL_HOURS', '1.5'],
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

  describe('auth settings', () => {
    it('requires both secrets', () => {
      const { JWT_ACCESS_SECRET: _a, REFRESH_TOKEN_PEPPER: _b, ...rest } = valid;
      const issues = issuesOf(rest);
      expect(issues).toContain('JWT_ACCESS_SECRET is required');
      expect(issues).toContain('REFRESH_TOKEN_PEPPER is required');
    });

    it('rejects short secrets without echoing them', () => {
      const issues = issuesOf({ ...valid, JWT_ACCESS_SECRET: 'short-secret-value' });
      expect(issues).toEqual(['JWT_ACCESS_SECRET must be at least 32 characters']);
      expect(issues.join()).not.toContain('short-secret-value');
    });

    it('rejects a pepper equal to the JWT secret', () => {
      expect(issuesOf({ ...valid, REFRESH_TOKEN_PEPPER: valid.JWT_ACCESS_SECRET })).toEqual([
        'REFRESH_TOKEN_PEPPER must differ from JWT_ACCESS_SECRET',
      ]);
    });

    it.each([
      ['90s', 90],
      ['1m', 60],
      ['15m', 900],
      ['1h', 3600],
    ])('parses JWT_ACCESS_TTL=%s as %i seconds', (ttl, seconds) => {
      expect(validateEnv({ ...valid, JWT_ACCESS_TTL: ttl }).JWT_ACCESS_TTL).toBe(seconds);
    });

    it.each(['59s', '61m', '2h', '15', '15 m', 'm15', '1d'])('rejects JWT_ACCESS_TTL=%s', ttl => {
      expect(
        issuesOf({ ...valid, JWT_ACCESS_TTL: ttl }).some(i => i.startsWith('JWT_ACCESS_TTL ')),
      ).toBe(true);
    });

    it('rejects an absolute session lifetime shorter than the idle lifetime', () => {
      expect(
        issuesOf({ ...valid, REFRESH_TOKEN_TTL_DAYS: '60', REFRESH_TOKEN_ABSOLUTE_TTL_DAYS: '30' }),
      ).toEqual(['REFRESH_TOKEN_ABSOLUTE_TTL_DAYS must be at least REFRESH_TOKEN_TTL_DAYS']);
    });

    it.each([
      ['REFRESH_TOKEN_TTL_DAYS', '0'],
      ['REFRESH_TOKEN_TTL_DAYS', '366'],
      ['REFRESH_TOKEN_ABSOLUTE_TTL_DAYS', '731'],
      ['JWT_ISSUER', '  '],
      ['JWT_AUDIENCE', ''],
    ])('rejects %s=%p', (key, value) => {
      expect(issuesOf({ ...valid, [key]: value }).some(i => i.startsWith(`${key} `))).toBe(true);
    });
  });
});
