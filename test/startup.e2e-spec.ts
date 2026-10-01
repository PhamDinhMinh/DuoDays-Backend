import { describe, expect, it } from 'vitest';

import { createTestApp } from './support/test-app.js';

describe('startup environment validation', () => {
  it('refuses to start without MONGODB_URI', async () => {
    await expect(createTestApp({ env: { MONGODB_URI: undefined } })).rejects.toThrow(
      /Invalid environment configuration:[\s\S]*MONGODB_URI is required/,
    );
  });

  it('refuses to start with malformed values and lists every problem', async () => {
    const attempt = createTestApp({
      env: { PORT: 'eighty', SWAGGER_ENABLED: 'yes', THROTTLE_LIMIT: '-1' },
    });
    await expect(attempt).rejects.toThrow(/PORT /);
    await expect(attempt).rejects.toThrow(/SWAGGER_ENABLED must be "true" or "false"/);
    await expect(attempt).rejects.toThrow(/THROTTLE_LIMIT /);
  });

  it('refuses an Atlas URI in tests and never echoes the secret', async () => {
    const attempt = createTestApp({
      env: { MONGODB_URI: 'mongodb+srv://dev:SuperSecretPw@cluster0.example.mongodb.net' },
    });
    await expect(attempt).rejects.toThrow(/must not point at an Atlas/);
    await expect(attempt).rejects.not.toThrow(/SuperSecretPw/);
  });
});
