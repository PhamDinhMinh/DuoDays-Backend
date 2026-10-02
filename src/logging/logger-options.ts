import { randomUUID } from 'node:crypto';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Options } from 'pino-http';

export const REQUEST_ID_HEADER = 'x-request-id';
export const REDACTED = '[REDACTED]';

/** A client-supplied request id is reused only if it is short and boring. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Property names whose values must never reach a log line, at any of the first 3 levels. */
const SENSITIVE_KEYS = [
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  'email',
  'emailNormalized',
  'displayName',
  'ownerName',
  'partnerName',
  'pendingPartnerName',
  'authorization',
  'token',
  'accessToken',
  'refreshToken',
  'tokenHash',
  'previousTokenHash',
  'refreshTokenHash',
  'idToken',
  'identityToken',
  'authorizationCode',
  'inviteCode',
  // Mongo duplicate-key errors: the offending values (an invite code, an email) live here.
  'keyValue',
  'errmsg',
  'secret',
  'apiKey',
  'pepper',
  'uri',
  'mongoUri',
  'MONGODB_URI',
  'JWT_ACCESS_SECRET',
  'REFRESH_TOKEN_PEPPER',
];

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS.flatMap(key => [key, `*.${key}`, `*.*.${key}`]),
];

export function resolveRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id =
    typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

export interface LoggerOptionsInput {
  level: string;
  pretty: boolean;
}

export function buildLoggerOptions({ level, pretty }: LoggerOptionsInput): Options {
  return {
    level,
    genReqId: resolveRequestId,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    // Response headers are static (helmet) noise and may carry Set-Cookie – status only.
    serializers: { res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }) },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) {
        return 'error';
      }
      return res.statusCode >= 400 ? 'warn' : 'info';
    },
    // Platform health probes would drown everything else.
    autoLogging: { ignore: req => req.url === '/health' },
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { singleLine: true, colorize: true } } }
      : {}),
  };
}
