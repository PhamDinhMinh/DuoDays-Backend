# DuoDays-Backend

REST API for the DuoDays couples app – NestJS 12 (ESM, TypeScript strict) + MongoDB Atlas via
Mongoose.

## Requirements

- Node **22.23.3** (see `.nvmrc`; `engine-strict` rejects other versions) and npm 10+
- A MongoDB Atlas **development** cluster connection string

You do not need MongoDB or Docker installed locally. Automated tests start their own
throwaway in-memory replica set (mongodb-memory-server downloads the binary on first run).

## Setup

```bash
nvm use
npm ci
cp .env.example .env   # then fill in MONGODB_URI (never commit .env)
npm run start:dev
```

- API: `http://localhost:3000/v1/...`
- Health: `GET http://localhost:3000/health`
- Swagger UI (only when `SWAGGER_ENABLED=true`): `http://localhost:3000/docs`, JSON at `/docs-json`

## Environment

Validated at startup (`src/config/env.schema.ts`); the app refuses to start on a missing or
malformed value and names the variable without echoing its value.

| Variable                                  | Required | Default                       | Notes                                     |
| ----------------------------------------- | -------- | ----------------------------- | ----------------------------------------- |
| `NODE_ENV`                                | no       | `development`                 | `development` \| `test` \| `production`   |
| `PORT`                                    | no       | `3000`                        |                                           |
| `LOG_LEVEL`                               | no       | `info`                        | pino level or `silent`                    |
| `SWAGGER_ENABLED`                         | no       | `false`                       | `true` \| `false`                         |
| `MONGODB_URI`                             | **yes**  | –                             | Secret. Atlas `mongodb+srv://…` URI       |
| `MONGODB_DB_NAME`                         | **yes**  | –                             | e.g. `duodays_dev`                        |
| `THROTTLE_TTL_SECONDS` / `THROTTLE_LIMIT` | no       | `60` / `100`                  | Global in-memory rate limit per client IP |
| `JWT_ACCESS_SECRET`                       | **yes**  | –                             | Secret. ≥ 32 chars (HS256 signing key)    |
| `JWT_ACCESS_TTL`                          | no       | `15m`                         | `<n>s\|m\|h`, between 1m and 1h           |
| `JWT_ISSUER` / `JWT_AUDIENCE`             | no       | `duodays-api` / `duodays-app` |                                           |
| `REFRESH_TOKEN_PEPPER`                    | **yes**  | –                             | Secret. ≥ 32 chars, ≠ `JWT_ACCESS_SECRET` |
| `REFRESH_TOKEN_TTL_DAYS`                  | no       | `30`                          | Idle session lifetime (1–365)             |
| `REFRESH_TOKEN_ABSOLUTE_TTL_DAYS`         | no       | `180`                         | Hard session lifetime (1–730, ≥ idle)     |
| `INVITE_TTL_HOURS`                        | no       | `24`                          | Couple invite code lifetime (1–168)       |

Rotating `REFRESH_TOKEN_PEPPER` signs everyone out; rotating `JWT_ACCESS_SECRET` invalidates
outstanding access tokens (clients refresh).

## API (so far)

| Method | Path                                 | Auth   | Notes                                                                                               |
| ------ | ------------------------------------ | ------ | --------------------------------------------------------------------------------------------------- |
| GET    | `/health`                            | public | Version-neutral; database ping                                                                      |
| POST   | `/v1/auth/register`                  | public | `{ displayName, email, password }` → 201 session                                                    |
| POST   | `/v1/auth/login`                     | public | `{ email, password }` → 200 session                                                                 |
| POST   | `/v1/auth/refresh`                   | public | `{ refreshToken }` → 200 `{ tokens }` (rotates)                                                     |
| POST   | `/v1/auth/logout`                    | public | `{ refreshToken }` → 204 (idempotent)                                                               |
| GET    | `/v1/auth/me`                        | Bearer | → 200 `{ user, activeCouple: {id,status} \| null }`                                                 |
| POST   | `/v1/couples`                        | Bearer | `{ ownerName, partnerName, startDate }` → 201 couple                                                |
| GET    | `/v1/couples/{id}`                   | Bearer | Members only (others: 404) → 200 couple                                                             |
| PATCH  | `/v1/couples/{id}`                   | Bearer | Creator only, pending only; any of the 3 fields                                                     |
| POST   | `/v1/couples/{id}/invite`            | Bearer | Creator, pending: current usable invite, or a new one → 200 `{ code, expiresAt, expiresInSeconds }` |
| POST   | `/v1/couples/{id}/invite/regenerate` | Bearer | Creator, pending: always a new code; the old one stops working → 200 invite                         |
| POST   | `/v1/couples/{id}/cancel`            | Bearer | Creator, pending: give up the couple (kept, not deleted) → 204                                      |
| POST   | `/v1/invites/lookup`                 | Bearer | `{ code }` → 200 `{ ownerName }`                                                                    |
| POST   | `/v1/invites/join`                   | Bearer | `{ code }` → 200 active couple (retry-safe for the same partner)                                    |

Invite errors: `INVITE_NOT_FOUND` 404; `INVITE_EXPIRED` 410 – **no longer usable**: expiry
passed _or_ the code was revoked (regenerated, or the couple was cancelled);
`INVITE_ALREADY_REDEEMED` 409; `ALREADY_IN_COUPLE` 409 (also for a creator typing their own
code). Invite codes travel only in request bodies – never in a URL, never in logs. Lookup and
join share one rate-limit budget per user and per IP (10/min, 20/hour); issuing and
regenerating share another (10/min, 30/hour). The creator polls `GET /v1/couples/{id}` to see
the partner arrive (`status` becomes `active`, `members` gains the partner).

Retry semantics: a repeated join by the same partner with the same code returns the same
couple only while the redeemed invite is retained (~24 h after the join); after that it is
`ALREADY_IN_COUPLE`. Cancel is not idempotent: retrying after a completed cancel is
`COUPLE_NOT_FOUND` 404, and a concurrent duplicate cancel that loses the race may get
`COUPLE_NOT_PENDING` 409.

## Scripts

| Script                 | What it does                                                         |
| ---------------------- | -------------------------------------------------------------------- |
| `npm run start:dev`    | Watch mode, pretty logs                                              |
| `npm run build`        | Production build to `dist/`                                          |
| `npm run start:prod`   | Run the production build (`node dist/main.js`)                       |
| `npm run typecheck`    | `tsc --noEmit` over src + tests                                      |
| `npm run lint`         | ESLint (type-aware)                                                  |
| `npm run format:check` | Prettier check (`npm run format` to fix)                             |
| `npm test`             | Unit tests (`src/**/*.spec.ts`)                                      |
| `npm run test:e2e`     | E2E tests (`test/**/*.e2e-spec.ts`) against an in-memory replica set |
| `npm run verify:dist`  | Build, then load the compiled module graph under plain Node ESM      |
| `npm run check`        | All of the above – run before every commit                           |

## Deployment prerequisites

Not implemented yet – required before the **first production deployment**:

- **Invariant-critical MongoDB indexes.** Production runs with Mongoose `autoIndex` disabled,
  so nothing creates indexes there automatically. An explicit index deployment/verification
  mechanism must exist and run (and fail the deployment if indexes are missing or differ) for:
  - `users.emailNormalized_1` – unique (partial) normalized-email uniqueness
  - `couple_memberships.userId_1` – unique, partial on `status: 'active'` (one active couple
    per user)
  - `couple_memberships.coupleId_1_role_1` – unique, partial on `status: 'active'` (one
    active creator and one active partner per couple)
  - `couple_invites.code_1` – unique (a code maps to one invite until it is purged)
  - `couple_invites.coupleId_1` – unique, partial on `status: 'active'` (one active invite
    per couple)
  - `couple_invites.purgeAt_1` – TTL cleanup only (correctness never depends on it)

  Without these, the corresponding guarantees are **not enforced** in production. Do not
  enable `autoIndex` in production as a substitute.

- **Reverse proxy / load balancer: `trust proxy`.** Per-IP rate limits (the global throttler
  and the invite buckets) key on `req.ip`. Behind a proxy that is the proxy's address unless
  Express `trust proxy` is configured – then every user shares one bucket. Before enabling
  it, validate the production platform's actual proxy topology and set `trust proxy` to the
  **exact number of trusted hops**. Never use `trust proxy = true`: it trusts any
  client-supplied `X-Forwarded-For`, letting callers pick their own IP and bypass per-IP
  limits. Not implemented in Phase 3.

- **Review per-IP limits for mobile networks.** Carrier-grade NAT and other shared-IP
  networks put many mobile users behind one address. The current per-IP limits (invite
  lookup/join 10/min and 20/hour, invite issue 10/min and 30/hour, cancel 10/min) may be too
  strict for that and must be reviewed before production traffic.
