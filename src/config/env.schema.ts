import { z } from 'zod';

/*
 * The process environment, validated once at startup. A missing or malformed value stops
 * the app before it listens. Only variables a shipped phase actually reads belong here –
 * auth and invite settings are added with their phases.
 */

const booleanString = z
  .enum(['true', 'false'], { error: 'must be "true" or "false"' })
  .transform(value => value === 'true');

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
  })
  .superRefine((env, ctx) => {
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
