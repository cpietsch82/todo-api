# Todo API

A fully type-safe Todo REST API built with Express, Drizzle ORM and Zod, including JWT authentication
with persistent refresh tokens and role/permission based authorization.

## Tech Stack

**Runtime & Framework**
- **Node.js 24** (see `.nvmrc`) / **TypeScript** - type-safe JavaScript
- **Express 5** - web framework
- **Zod** - request validation (body and params) and type inference
- **Pino / pino-http** - structured logging (`pino-pretty` in development)

**Database**
- **PostgreSQL 16** - database
- **Drizzle ORM** (`drizzle-orm`, `drizzle-kit`, `drizzle-zod`) - queries, schema and migrations
- **postgres.js** - database driver in production
- **PGlite** - in-memory PostgreSQL used for tests

**Authentication & Authorization**
- **Jose** - signing and verifying JWT access tokens (HS256)
- **bcrypt** - password hashing
- Opaque **refresh tokens**, stored hashed (SHA-256) in the `refresh_tokens` table and rotated on every use
- Role/permission based access control (`user`, `admin`) stored in the database

**Security & Middleware**
- **helmet** - security headers
- **cors** - allowed origins via `ALLOWED_ORIGINS`
- **express-rate-limit** - rate limiting for `/api`
- **compression**, **cookie-parser**

**Tooling**
- **Vitest** + **Supertest** - unit and integration tests
- **ESLint** (typescript-eslint) - linting
- **nodemon**, **ts-node**, **tsc-alias** - development and build
- **Docker / Docker Compose** - container image, Postgres and Adminer
- **GitHub Actions** - lint, build, test and image push to GHCR (development and release)

## Getting Started

```bash
nvm use                # Node 24
npm ci
cp .env.example .env   # and fill in all variables listed below
npm run docker:up      # starts Postgres (and Adminer) via Docker Compose
npm run db:migrate     # applies the migrations from ./drizzle
npm run dev            # starts the API with nodemon
```

### Environment Variables

Validated at startup in `env.ts` (the process exits when something is missing or invalid).

| Variable | Description |
|---|---|
| `APP_STAGE` | `dev`, `test` or `production` |
| `PORT` | Port of the API (default `3000`) |
| `DATABASE_URL` | Must start with `postgresql://` (not needed for tests) |
| `ALLOWED_ORIGINS` | Comma separated list of allowed CORS origins |
| `LOG_LEVEL` | `trace`, `debug`, `info`, `warn`, `error` or `fatal` |
| `ACCESS_TOKEN_SECRET` / `REFRESH_TOKEN_SECRET` | Secrets for the tokens |
| `ACCESS_TOKEN_TTL` | Lifetime of the access token, e.g. `15m` |
| `REFRESH_TOKEN_TTL` / `REFRESH_TOKEN_TTL_MS` | Lifetime of the refresh token (`REFRESH_TOKEN_TTL_MS` is used) |
| `BCRYPT_SALT_ROUNDS` | Cost factor for bcrypt (min. 8) |
| `EXPOSE_ERROR_DETAILS` | Developer flag (default `false`): responses contain the complete error message and stack trace of unexpected errors. The API refuses to start with it when `APP_STAGE=production` |
| `RATE_LIMIT_PER_IP` / `RATE_LIMIT_WINDOW_MS` | Requests per IP (min. 100) within the time window |

The Postgres container reads `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB` from `.env.database`,
the API container reads `.env.api`.

### Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start the API with nodemon |
| `npm run build` / `npm start` | Compile with `tsconfig.build.json` (without tests) / start the compiled app |
| `npm test` / `npm run test:run` | Run the tests in watch mode / once |
| `npm run test:coverage` | Run the tests with coverage |
| `npm run lint` / `lint:fix` | Lint the code |
| `npm run db:generate` / `db:migrate` / `db:push` / `db:studio` | Drizzle Kit commands |
| `npm run docker:up` / `docker:down` / `docker:reset` | Manage the Docker Compose services |

Releases are created with `npm version` on the `main` branch; the CI verifies that the release tag matches
the version in `package.json`.

## API Overview

All routes live under `/api`. Everything except the routes marked as public requires a
`Authorization: Bearer <accessToken>` header.

| Route | Description |
|---|---|
| `GET /health` | Health check including database state (public) |
| `GET /version` | Name, version, stage and commit of the running API (public) |
| `POST /auth/register`, `/auth/login`, `/auth/refresh` | Registration, login and token rotation (public) |
| `POST /auth/logout` | Revokes the given refresh token |
| `/todos` | CRUD for todos (owner or admin) |
| `/todo-comments` | CRUD for todo comments (owner or admin) |
| `/users` | List, read, update and delete users (own user or admin) |
| `/admin` | Admin only, no routes yet |

Permissions (`todos:read`, `users:delete`, ...) are defined in `src/modules/authorization/permissions.ts`;
`admin:all` grants every permission.

## Error Handling

Errors are answered by `globalErrorHandler` (`src/middleware/globalErrorHandler.ts`) through the response helpers
of `ExpressAPI` (`respondBadRequest`, `respondConflict`, `respondAuthorizationRequired`, ...).

- Throw an `HttpError` (`src/utils/HttpError.ts`, e.g. `HttpError.conflict("...")`) when the message is meant for the client.
- Unique and foreign key violations of the database are mapped to 409 and 400 without exposing the query.
- Every other error is answered with a generic text. For 5xx errors it contains an error id
  (`Internal Server Error (Error ID: ...)`, also sent as `X-Error-ID` header) which can be looked up in the logs.
- Logged errors are cleaned by the serializer in `src/utils/logger.ts`: the values of failed database queries
  (e.g. emails or password hashes) are replaced by `[REDACTED]`, and common secret fields (`password`, `token`,
  `refreshToken`, `authorization`, ...) are censored when they are logged as part of an object.
- For development set `EXPOSE_ERROR_DETAILS=true` to receive the complete message and stack trace in the response.

## Project Structure

```
todo-api/
├── src/
│   ├── db/
│   │   ├── schema/
│   │   │   └── index.ts            # Collects all module schemas for Drizzle
│   │   ├── index.ts                # Database connection (postgres.js) and waitForDatabase
│   │   └── migrate.ts              # Migration runner (used by entrypoint.sh)
│   ├── middleware/
│   │   ├── authenticateToken.ts    # Reads and verifies the access token
│   │   ├── permissions.ts          # requirePermissions, requireSelf and ownership checks
│   │   ├── validate.ts             # Zod validation of body and params
│   │   ├── globalErrorHandler.ts   # Error handler (status + message, error id for 5xx)
│   │   └── httpLogger.ts           # Request logging
│   ├── modules/
│   │   ├── core/
│   │   │   ├── BaseModule.ts       # Base class for all modules
│   │   │   ├── APIModule.ts        # Base class for modules that expose Express routes
│   │   │   └── StorageModule.ts    # Generic base for database backed modules
│   │   ├── express/                # ExpressAPI (app setup, routing, response helpers), VersionService
│   │   ├── authentication/         # Register, login, JWT and persistent refresh tokens
│   │   ├── authorization/          # Roles, permissions and their resolution per user
│   │   ├── admin/                  # Admin API (guarded by admin:all, no routes yet)
│   │   ├── users/
│   │   └── todos/                  # Todos and todo comments
│   │       ├── schema/             # Drizzle tables and Zod schemas
│   │       ├── test/               # Tests of the module
│   │       ├── TodoAPI.ts          # Routes
│   │       └── TodoService.ts      # Business logic
│   ├── utils/                      # logger, passwords, typedHandler, ErrorWithCode
│   └── index.ts                    # Application entry point
├── tests/                          # Test setup (PGlite database, Express app) and helpers
├── drizzle/                        # SQL migrations
├── .github/workflows/ci.yml        # Lint, build, test, Docker push
├── Dockerfile / docker-compose.yml / entrypoint.sh
├── tsconfig.json                   # IDE and type checking (includes tests)
├── tsconfig.build.json             # Production build (excludes tests)
├── drizzle.config.ts / env.ts / nodemon.json / vitest.config.ts
└── package.json
```

Every feature module follows the same pattern: `XAPI` (routes, extends `APIModule`), `XService`
(business logic, extends `BaseModule`), `schema/` (Drizzle table plus Zod schemas) and `test/`.
Modules are singletons and registered in `src/index.ts`.

## Testing

Tests run against an in-memory PGlite database that gets all migrations applied, so no running Postgres is
needed. Use `npm run test:run`; the Node version from `.nvmrc` is required.
