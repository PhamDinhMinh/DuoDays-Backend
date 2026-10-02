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
    validation/      ValidationKey, createValidationPipe(), @PersonName(), @Trim(),
                     @IsRelationshipStartDate(), UTF-16 length validators
    dates/           calendar-date.ts – the ONLY place calendar-date rules live
    ids/             createPublicId / isPublicId
    swagger/         @ApiErrorResponses()
    throttling/      @UserRateLimit() – per-user + per-IP shared buckets (route guard)
  database/          DatabaseModule (Mongoose), TransactionService
  logging/           nestjs-pino: request ids, redaction, LOG_DESTINATION
  health/            GET /health (version-neutral, unthrottled, @Public)
  modules/
    users/           User schema, UsersService, UserDto/toUserDto, normalizeEmail
    auth/            register/login/refresh/logout/me; PasswordHasher (Argon2id),
                     AccessTokenService (JWT), AuthSessionsService (refresh sessions),
                     JwtAuthGuard (global), @Public(), @CurrentUser()
    couples/         Couple + CoupleMembership + CoupleInvite schemas, CouplesService
                     (create/read/update, /auth/me summary, session-aware conditional
                     status writes), CoupleMembershipsService, CoupleInvitesService
                     (session-aware), CoupleAccessService (requireCaller/requireMember/
                     requireCreator), CoupleSetupService (invite issue/regenerate, cancel,
                     lookup, join), InviteCodeGenerator, InvitesController (/invites/*)
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
- `autoIndex` is off in production. **Deployment prerequisite (not built yet):** before the
  first production deployment there must be an explicit index deployment/verification step
  for every invariant-critical index – users `emailNormalized_1`, couple_memberships
  `userId_1` and `coupleId_1_role_1`, couple_invites `code_1` and `coupleId_1`. (The
  couple_invites `purgeAt_1` TTL index is cleanup only, not correctness-critical.) Without
  it those invariants are not enforced in production. Do not "fix" this by enabling
  autoIndex in production. See README → Deployment prerequisites.
- Duplicate-key errors are classified by `keyPattern` (`isDuplicateKeyOn`): the driver
  exposes no structured index name (its `index` field is the batch position; the name is
  only in `errmsg`). Never parse `errmsg`. The exception filter logs only the class, code
  and key pattern of a duplicate-key error – its message/`keyValue` contain the value.
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

### Couples

- Membership lives in `couple_memberships`, never embedded in `couples`. Two partial unique
  indexes (only `status: 'active'` rows) are the real guarantees: one active couple per user
  (`userId_1`) and at most one creator + one partner per couple (`coupleId_1_role_1`).
  Application pre-checks exist only for clean errors; map the duplicate-key error too.
- Couple-scoped endpoints start with `CoupleAccessService.requireMember(auth, coupleId)`.
  Non-members, unknown and malformed ids all get the same 404 `COUPLE_NOT_FOUND` – never
  reveal that a couple exists. Status rules (pending/active) go into the write's filter.
- Couple status: `pending | active | cancelled`. Only the join transaction sets `active`; only
  cancel sets `cancelled` (and ends the creator membership as `left` in the same
  transaction). `cancelled` is internal – the public DTO enum is `PUBLIC_COUPLE_STATUSES`.
- Every couple-setup transaction writes the couple document with a `status: 'pending'`
  filter, so concurrent operations on one couple conflict and MongoDB serialises them (the
  later writer gets a write conflict; its transaction is retried against the committed
  state). Issue/regenerate (`lockPending`) and cancel (`cancelPending`) write the couple
  **first**; new setup transactions must do the same. Both filters also carry
  `createdByUserId` (defence in depth behind `requireCreator`).
- **Join is the intentional exception**: its first gate is the invite redemption
  compare-and-swap, the couple write (`activatePending`) comes second. That way a join
  that loses to a concurrent join/regenerate/cancel fails on the invite and gets the
  precise invite error (`INVITE_ALREADY_REDEEMED` / `INVITE_EXPIRED`). It stays safe
  because every competing transaction writes the same invite and/or couple document. Do
  not "fix" the order. Races are covered with write-boundary barriers in
  `test/couples-setup-races.e2e-spec.ts` (`test/support/barrier.ts`).
- Cancel is not idempotent (current semantics, documented in Swagger): a sequential retry
  after a completed cancel is 404 `COUPLE_NOT_FOUND` (no longer a member); a concurrent
  losing cancel that passed the pre-check is 409 `COUPLE_NOT_PENDING`.
- `startDate` (and every future calendar date) is a `YYYY-MM-DD` **string** end-to-end:
  DTO → MongoDB → response. Never construct a `Date` from it, never store it as a BSON
  Date. Validation/bounds come only from `common/dates/calendar-date.ts`.
- Never log names, placeholder names or dates – public ids and field names only.
- Invites (`couple_invites`): stored states `active | redeemed | revoked`; expiry is derived
  (`usable ⇔ active && now < expiresAt`) – never stored, never left to the TTL index
  (`purgeAt` is cleanup only). `code` is unique across all invites until purged;
  `coupleId` is unique among active ones. Join redeems with a compare-and-swap on
  `{status:'active', expiresAt > now}` and sets `redeemedAt` in the same transaction.
- Join replay (same partner, same code → 200 same couple) works only while the redeemed
  invite is retained (`INVITE_RETENTION_MS`, ~24 h after redemption). After the purge the
  partner gets `ALREADY_IN_COUPLE`. A purged code may eventually be issued again (accepted).
- `INVITE_EXPIRED` means "no longer usable": expired **or** revoked. Do not narrow it.
- Invite codes are secrets: only in request/response bodies, never in a URL, a log call or
  an error message. A code duplicate-key error must never escape (it contains the code).
- Code-guessing routes use `@UserRateLimit` with a shared bucket (`INVITE_RATE_LIMITS`).
  The guard runs before the ValidationPipe, so malformed bodies spend the budget too.
  Per-IP buckets rely on `req.ip`: behind a proxy, `trust proxy` must be set to the exact
  hop count (never `true`) – a deployment prerequisite, see README. The per-IP limits must
  be reviewed for carrier-NAT/shared-IP mobile users before production traffic.
- `npm run test:tz` re-runs date + couple tests under Asia/Ho_Chi_Minh and
  America/New_York; keep new date logic covered there.

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
