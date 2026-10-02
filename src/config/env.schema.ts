import { z } from 'zod';

/*
 * The process environment, validated once at startup. A missing or malformed value stops
 * the app before it listens. Only variables a shipped phase actually reads belong here.
 */

const booleanString = z
  .enum(['true', 'false'], { error: 'must be "true" or "false"' })
  .transform(value => value === 'true');

const TTL_UNIT_SECONDS = { s: 1, m: 60, h: 3600 } as const;

/** `"15m"` → 900. Accepts `<n>s`, `<n>m` or `<n>h`. */
const durationSeconds = z
  .string()
  .trim()
  .regex(/^\d+[smh]$/, { error: 'must look like "90s", "15m" or "1h"' })
  .transform(value => {
    const unit = value.slice(-1) as keyof typeof TTL_UNIT_SECONDS;
    return Number(value.slice(0, -1)) * TTL_UNIT_SECONDS[unit];
  });

/** At least 32 characters – e.g. 32 random bytes base64url-encoded (43 chars). */
const secret = z
  .string({ error: 'is required' })
  .min(32, { error: 'must be at least 32 characters' });

const days = (max: number) =>
  z.coerce
    .number({ error: 'must be a number' })
    .int({ error: 'must be a whole number' })
    .min(1, { error: `must be between 1 and ${max}` })
    .max(max, { error: `must be between 1 and ${max}` });

const positiveInt = z.coerce
  .number({ error: 'must be a number' })
  .int({ error: 'must be a whole number' })
  .positive({ error: 'must be greater than 0' });

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce
      .number({ error: 'must be a number' })
      .int({ error: 'must be a whole number' })
      .min(1, { error: 'must be between 1 and 65535' })
      .max(65_535, { error: 'must be between 1 and 65535' })
      .default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    SWAGGER_ENABLED: booleanString.default(false),

    MONGODB_URI: z
      .string({ error: 'is required' })
      .trim()
      .min(1, { error: 'is required' })
      .regex(/^mongodb(\+srv)?:\/\//, { error: 'must be a mongodb:// or mongodb+srv:// URI' }),
    MONGODB_DB_NAME: z
      .string({ error: 'is required' })
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,38}$/, { error: 'must be 1–38 letters, digits, "_" or "-"' }),

    THROTTLE_TTL_SECONDS: positiveInt.default(60),
    THROTTLE_LIMIT: positiveInt.default(100),

    JWT_ACCESS_SECRET: secret,
    /** Seconds after transform. */
    JWT_ACCESS_TTL: durationSeconds
      .refine(seconds => seconds >= 60 && seconds <= 3600, {
        error: 'must be between 1 minute and 1 hour',
      })
      .prefault('15m'),
    JWT_ISSUER: z.string().trim().min(1, { error: 'must not be empty' }).default('duodays-api'),
    JWT_AUDIENCE: z.string().trim().min(1, { error: 'must not be empty' }).default('duodays-app'),

    REFRESH_TOKEN_PEPPER: secret,
    REFRESH_TOKEN_TTL_DAYS: days(365).default(30),
    REFRESH_TOKEN_ABSOLUTE_TTL_DAYS: days(730).default(180),

    /** How long a couple invite code stays usable after it is issued. */
    INVITE_TTL_HOURS: z.coerce
      .number({ error: 'must be a number' })
      .int({ error: 'must be a whole number' })
      .min(1, { error: 'must be between 1 and 168' })
      .max(168, { error: 'must be between 1 and 168' })
      .default(24),
  })
  .superRefine((env, ctx) => {
    if (env.REFRESH_TOKEN_PEPPER === env.JWT_ACCESS_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['REFRESH_TOKEN_PEPPER'],
        message: 'must differ from JWT_ACCESS_SECRET',
      });
    }
    if (env.REFRESH_TOKEN_ABSOLUTE_TTL_DAYS < env.REFRESH_TOKEN_TTL_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['REFRESH_TOKEN_ABSOLUTE_TTL_DAYS'],
        message: 'must be at least REFRESH_TOKEN_TTL_DAYS',
      });
    }
    // Automated tests run against mongodb-memory-server only – never a shared Atlas cluster.
    if (env.NODE_ENV === 'test' && env.MONGODB_URI.startsWith('mongodb+srv://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['MONGODB_URI'],
        message: 'must not point at an Atlas (mongodb+srv) cluster when NODE_ENV=test',
      });
    }
  });

export type Env = z.output<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map(issue => `  - ${issue}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Parses `process.env`-shaped input. Error messages name the variable and the rule only –
 * never the received value, which may be a secret.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map(issue => `${issue.path.join('.') || '(root)'} ${issue.message}`),
    );
  }
  return result.data;
}
