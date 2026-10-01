# DuoDays Backend – project rules

REST API for the DuoDays React Native app (`../duodays`). NestJS 12 (ESM) + TypeScript strict +
MongoDB Atlas via Mongoose. One backend instance for the MVP.

## 1. Git (permanent rule)

- Never commit or push automatically.
- Never rewrite Git history automatically.
- Never run git reset, rebase, merge, cherry-pick, tag, commit, push, force-push, or similar
  history/remote-changing commands unless the user explicitly requests that exact Git
  operation.
- Read-only Git commands such as git status, git diff and git log are allowed.
- All normal commits and pushes are performed manually by the user.

## 2. Scope discipline

- Build only what the current, approved phase covers. No speculative CRUD endpoints, no
  dependencies reserved for later phases (e.g. argon2, @nestjs/jwt, jose before Phase 1/5).
- No Redis (in-memory throttling is correct for one instance), no Atlas resource creation, no
  deployment, no frontend changes unless explicitly approved.
- Never put secrets in source control. `.env` is ignored; only `.env.example` (names and safe
  defaults, no values for secrets) is tracked.

## 3. Commands

Use Node from `.nvmrc` (`nvm use`). `npm run check` = typecheck + lint + format:check + unit +
e2e + `verify:dist`. Run it before reporting work as done.

## 4. Architecture

```
src/
  main.ts            bootstrap → configureApp() → listen
  app.setup.ts       configureApp(): helmet, JSON body limit, URI versioning (/v1),
                     ValidationPipe, Swagger. Shared by main.ts and the e2e app factory.
  app.module.ts      Config, Logging, Database, Throttler (APP_GUARD), exception filter
                     (APP_FILTER), feature modules
  config/            env.schema.ts (zod, the only reader of process.env) + AppConfigService
  common/
    errors/          ErrorCode, AppException, GlobalExceptionFilter, ErrorResponseDto
    validation/      ValidationKey, createValidationPipe()
    ids/             createPublicId / isPublicId
    swagger/         @ApiErrorResponses()
  database/          DatabaseModule (Mongoose), TransactionService
  logging/           nestjs-pino: request ids, redaction, LOG_DESTINATION
  health/            GET /health (version-neutral, unthrottled, @Public)
  modules/
    users/           User schema, UsersService, UserDto/toUserDto, normalizeEmail
    auth/            register/login/refresh/logout/me; PasswordHasher (Argon2id),
                     AccessTokenService (JWT), AuthSessionsService (refresh sessions),
                     JwtAuthGuard (global), @Public(), @CurrentUser()
test/
  support/           global-setup (in-memory replica set), test-app factory, ProbeModule
  *.e2e-spec.ts
```

## 5. Conventions

### ESM

- `"type": "module"`. Relative imports end in `.js`.
- **CommonJS packages (mongoose) may not expose named exports to Node ESM.** Use
  `import mongoose from 'mongoose'` for runtime values (`mongoose.ConnectionStates`,
  `mongoose.trusted`) and `import type { … } from 'mongoose'` for types. Vitest hides this
  class of bug; `npm run verify:dist` catches it.
- Constructor parameters injected by type must be value imports; everything else that is
  only a type uses `import type` (ESLint enforces).

### Configuration

- Read config only through `AppConfigService` – never `process.env`.
- New variable → add to `env.schema.ts`, `AppConfigService`, `.env.example`, README table, and
  `test/support/test-app.ts` (`ENV_KEYS`/defaults).
- Validation messages name the variable and rule, never the value.

### Errors

- Throw `AppException(ErrorCode.X, HttpStatus.Y, 'Developer message.', details?)` for every
  expected failure. Add new domain codes to `ErrorCode`; never reuse a code for a new meaning.
- Response shape is always `{ error: { code, message, details?, requestId } }`. Do not build
  error bodies anywhere else. Unknown errors become 500 `INTERNAL` with nothing leaked.
- A Mongo duplicate-key error reaching the filter becomes 409 `CONFLICT` – a backstop only.
  Services pre-check and throw a domain-specific code.
- Success responses are the DTO itself – no `{ data }` envelope.

### Validation

- Global `ValidationPipe`: whitelist + forbidNonWhitelisted + transform + stopAtFirstError.
- Pass a `ValidationKey` as each decorator's `message` (`required`, `invalidEmail`,
  `passwordTooShort`, `nameTooLong`, `invalidDate` mirror the app's keys).
- class-validator runs decorators **bottom-up**: put the "required" check (`@IsNotEmpty` /
  `@IsDefined`) **lowest** so it wins for missing values.

### Database

- Global `sanitizeFilter` is on: any `$`-operator inside a query filter is neutralised.
  Operators written by our code must be wrapped: `{ expiresAt: mongoose.trusted({ $gt: now }) }`.
- `autoIndex` is off in production; indexes are synced explicitly on deploy.
- Multi-document writes go through `TransactionService.run(session => …)`. Pass `session` to
  every operation; the callback may be retried, so no side effects outside MongoDB inside it.
- Expose `publicId` (`usr_…`, `cpl_…`), never `_id`. Map documents to DTOs; never return
  Mongoose documents.

### Logging

- Use Nest `Logger` (backed by pino). Logs are JSON in production, pretty in development.
- Never log request bodies, tokens, passwords or invite codes. Redaction (`logger-options.ts`)
  is a safety net, not a licence; add new sensitive field names to `SENSITIVE_KEYS`.

### Auth

- **Every route requires a valid access token unless marked `@Public()`.** The global
  `JwtAuthGuard` runs after the throttler. Never weaken this default.
- In protected handlers take `@CurrentUser() auth: AuthContext` (`{ userId: 'usr_…',
sessionId: 'ses_…' }`) and resolve the user via `UsersService.findByPublicId`. Never accept a
  user id from the body/path for "who am I".
- Passwords are used exactly as received: never trim, case-fold or Unicode-normalize them.
  Hash only via `PasswordHasher`; never hash inside a transaction callback (it may retry).
- Never store raw refresh tokens or access tokens. Refresh-session changes are single
  conditional updates in `AuthSessionsService` – keep rotation a compare-and-swap.
- Never log emails, passwords, hashes, tokens or the Authorization header – log `usr_`/`ses_`
  ids and outcome codes only.
- Access tokens are stateless: `JwtAuthGuard` verifies signature/claims only and never reads
  the database, so a token for a deleted user or revoked session passes the guard until it
  expires (≤ `JWT_ACCESS_TTL`). Handlers that need the user must load it via
  `UsersService.findByPublicId` and throw 401 `UNAUTHENTICATED` if it is gone (as
  `AuthService.me` does).
- Per-route limits live in `AUTH_THROTTLE`; e2e tests that create many users pass
  `createTestApp({ throttling: false })`.

### API

- Routes are `/v1/...` via URI versioning; operational endpoints use
  `version: VERSION_NEUTRAL`.
- Document error responses with `@ApiErrorResponses(...)`. The Swagger CLI plugin infers DTO
  properties at build time.

### Tests

- Unit: `src/**/*.spec.ts` (no DB). E2E: `test/**/*.e2e-spec.ts` via `createTestApp()`, which
  boots the real AppModule with `configureApp()` and a per-app database.
- Never point tests at Atlas (`env.schema.ts` rejects `mongodb+srv` under `NODE_ENV=test`).
- Import test APIs from `vitest` explicitly.
