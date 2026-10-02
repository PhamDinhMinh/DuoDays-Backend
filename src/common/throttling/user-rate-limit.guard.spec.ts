import 'reflect-metadata';

import { Reflector } from '@nestjs/core';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppException } from '../errors/app.exception.js';
import { UserRateLimit, UserRateLimitGuard } from './user-rate-limit.guard.js';

import type { ExecutionContext } from '@nestjs/common';

const WINDOWS = [
  { limit: 3, ttlMs: 60_000 },
  { limit: 5, ttlMs: 3_600_000 },
];

class Routes {
  @UserRateLimit('codes', WINDOWS)
  lookup(): void {}

  @UserRateLimit('codes', WINDOWS)
  join(): void {}

  @UserRateLimit('other', WINDOWS)
  elsewhere(): void {}

  unlimited(): void {}
}

type Route = 'lookup' | 'join' | 'elsewhere' | 'unlimited';

/** The decorated method itself (decorator metadata lives on it), without calling it. */
function handlerOf(route: Route): () => void {
  return Object.getOwnPropertyDescriptor(Routes.prototype, route)?.value as () => void;
}

function contextFor(route: Route, request: { ip?: string; auth?: { userId: string } }) {
  const headers: Record<string, string> = {};
  const context = {
    getHandler: () => handlerOf(route),
    getClass: () => Routes,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ header: (name: string, value: string) => (headers[name] = value) }),
    }),
  } as unknown as ExecutionContext;
  return { context, headers };
}

describe('UserRateLimitGuard', () => {
  const storage = new ThrottlerStorageService();
  const guard = new UserRateLimitGuard(new Reflector(), storage);
  let n = 0;
  /** Fresh ids per test: the storage is shared. */
  const fresh = () => {
    n += 1;
    return { user: `usr_${n}`, ip: `10.0.0.${n}` };
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  async function attempt(route: Route, request: { ip?: string; auth?: { userId: string } }) {
    const { context, headers } = contextFor(route, request);
    try {
      return { allowed: await guard.canActivate(context), headers };
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).getStatus()).toBe(429);
      expect((error as AppException).code).toBe('RATE_LIMITED');
      return { allowed: false, headers };
    }
  }

  it('lets routes without a bucket through', async () => {
    const { ip } = fresh();
    for (let i = 0; i < 10; i += 1) {
      expect((await attempt('unlimited', { ip })).allowed).toBe(true);
    }
  });

  it('limits one user even when they change IP', async () => {
    const { user } = fresh();
    for (let i = 0; i < 3; i += 1) {
      const ip = fresh().ip;
      expect((await attempt('lookup', { ip, auth: { userId: user } })).allowed).toBe(true);
    }
    const blocked = await attempt('lookup', {
      ip: fresh().ip,
      auth: { userId: user },
    });
    expect(blocked.allowed).toBe(false);
    expect(Number(blocked.headers['Retry-After'])).toBeGreaterThan(0);
  });

  it('limits one IP even when the user changes', async () => {
    const { ip } = fresh();
    for (let i = 0; i < 3; i += 1) {
      const auth = { userId: fresh().user };
      expect((await attempt('lookup', { ip, auth })).allowed).toBe(true);
    }
    expect((await attempt('lookup', { ip, auth: { userId: fresh().user } })).allowed).toBe(false);
  });

  it('routes naming the same bucket share the budget; other buckets do not', async () => {
    const { user, ip } = fresh();
    const request = { ip, auth: { userId: user } };
    expect((await attempt('lookup', request)).allowed).toBe(true);
    expect((await attempt('join', request)).allowed).toBe(true);
    expect((await attempt('lookup', request)).allowed).toBe(true);
    expect((await attempt('join', request)).allowed).toBe(false);
    expect((await attempt('elsewhere', request)).allowed).toBe(true);
  });

  it('enforces the longer window after the short one resets', async () => {
    vi.useFakeTimers();
    const { user, ip } = fresh();
    const request = { ip, auth: { userId: user } };
    for (let i = 0; i < 3; i += 1) {
      expect((await attempt('lookup', request)).allowed).toBe(true);
    }
    vi.advanceTimersByTime(61_000);
    expect((await attempt('lookup', request)).allowed).toBe(true);
    expect((await attempt('lookup', request)).allowed).toBe(true);
    // 5 per hour reached.
    expect((await attempt('lookup', request)).allowed).toBe(false);
  });
});
