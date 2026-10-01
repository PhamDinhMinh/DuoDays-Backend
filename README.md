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

`INVITE_TTL_HOURS` in `.env.example` is reserved for a later phase and not read yet.
Rotating `REFRESH_TOKEN_PEPPER` signs everyone out; rotating `JWT_ACCESS_SECRET` invalidates
outstanding access tokens (clients refresh).

## API (so far)

| Method | Path                | Auth   | Notes                                            |
| ------ | ------------------- | ------ | ------------------------------------------------ |
| GET    | `/health`           | public | Version-neutral; database ping                   |
| POST   | `/v1/auth/register` | public | `{ displayName, email, password }` → 201 session |
| POST   | `/v1/auth/login`    | public | `{ email, password }` → 200 session              |
| POST   | `/v1/auth/refresh`  | public | `{ refreshToken }` → 200 `{ tokens }` (rotates)  |
| POST   | `/v1/auth/logout`   | public | `{ refreshToken }` → 204 (idempotent)            |
| GET    | `/v1/auth/me`       | Bearer | → 200 `{ user }`                                 |

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
