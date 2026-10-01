import { HttpStatus, NotFoundException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { describe, expect, it, vi } from 'vitest';

import { AppException } from './app.exception.js';
import { ErrorCode } from './error-codes.js';
import { GlobalExceptionFilter } from './global-exception.filter.js';

import type { ArgumentsHost } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';

function run(exception: unknown, request: { id?: unknown } = { id: 'req-12345678' }) {
  const reply = vi.fn();
  const filter = new GlobalExceptionFilter({
    httpAdapter: { reply },
  } as unknown as HttpAdapterHost);
  const host = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
  } as unknown as ArgumentsHost;
  // Keep the expected 5xx error log out of the test output.
  vi.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
  vi.spyOn(filter['logger'], 'warn').mockImplementation(() => undefined);
  filter.catch(exception, host);
  const [, body, status] = reply.mock.calls[0] as [unknown, unknown, number];
  return { body, status };
}

describe('GlobalExceptionFilter', () => {
  it('passes AppException code, message and details through', () => {
    const exception = new AppException(ErrorCode.CONFLICT, HttpStatus.CONFLICT, 'Taken.', [
      { field: 'email', code: 'invalid' },
    ]);
    expect(run(exception)).toEqual({
      status: 409,
      body: {
        error: {
          code: 'CONFLICT',
          message: 'Taken.',
          details: [{ field: 'email', code: 'invalid' }],
          requestId: 'req-12345678',
        },
      },
    });
  });

  it('omits empty details', () => {
    const { body } = run(new AppException(ErrorCode.BAD_REQUEST, 400, 'Nope.', []));
    expect(body).toEqual({
      error: { code: 'BAD_REQUEST', message: 'Nope.', requestId: 'req-12345678' },
    });
  });

  it('maps framework HTTP exceptions by status with a generic message', () => {
    expect(run(new NotFoundException('Cannot GET /secret-route'))).toEqual({
      status: 404,
      body: {
        error: { code: 'NOT_FOUND', message: 'Resource not found.', requestId: 'req-12345678' },
      },
    });
    expect(run(new ThrottlerException()).body).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });

  it('hides unknown errors behind 500 INTERNAL', () => {
    const { status, body } = run(new Error('connection string mongodb://u:p@host leaked'));
    expect(status).toBe(500);
    expect(body).toEqual({
      error: { code: 'INTERNAL', message: 'Internal server error.', requestId: 'req-12345678' },
    });
  });

  it('maps a Mongo duplicate-key error to 409 CONFLICT without leaking the key', () => {
    const duplicate = Object.assign(new Error('E11000 dup key: { email: "a@b.co" }'), {
      name: 'MongoServerError',
      code: 11000,
    });
    const { status, body } = run(duplicate);
    expect(status).toBe(409);
    expect(JSON.stringify(body)).not.toContain('a@b.co');
  });

  it('surfaces exposed 4xx http-errors (body-parser) by status', () => {
    const parseError = Object.assign(new SyntaxError('Unexpected token } in JSON'), {
      status: 400,
      expose: true,
      type: 'entity.parse.failed',
    });
    expect(run(parseError)).toMatchObject({
      status: 400,
      body: { error: { code: 'BAD_REQUEST' } },
    });
    const tooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      expose: true,
    });
    expect(run(tooLarge)).toMatchObject({
      status: 413,
      body: { error: { code: 'PAYLOAD_TOO_LARGE' } },
    });
  });

  it('does not trust unexposed or 5xx http-errors', () => {
    expect(run(Object.assign(new Error('x'), { status: 400 })).status).toBe(500);
    expect(run(Object.assign(new Error('x'), { status: 502, expose: true })).status).toBe(500);
  });

  it('generates a request id when the request has none', () => {
    const { body } = run(new Error('x'), {});
    expect((body as { error: { requestId: string } }).error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
