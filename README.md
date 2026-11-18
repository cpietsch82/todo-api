# Todo API

A fully type-safe Todo REST API built with Express, Drizzle ORM and Zod, including JWT authentication
with persistent refresh tokens and role/permission based authorization.

## Tech Stack

**Runtime & Framework**
- **Node.js 24** (see `.nvmrc`) / **TypeScript** - type-safe JavaScript
- **Express 5** - web framework
- **Zod** - request validation (body and params) and type inference
- **Pino / pino-http** - structured logging (`pino-pretty` in development, `pino-roll` for rotated log files)

**Database**
- **PostgreSQL 16** - database
- **Drizzle ORM** (`drizzle-orm`, `drizzle-kit`, `drizzle-zod`) - queries, schema and migrations
- **postgres.js** - database driver in production
- **PGlite** - in-memory PostgreSQL used for tests

**Authentication & Authorization**
- **Jose** - signing and verifying JWT access tokens (HS256, only tokens issued by this API for this API are accepted)
- **bcrypt** - password hashing
- Opaque **refresh tokens**, stored hashed (SHA-256) in the `refresh_tokens` table and rotated on every use.
  Rotated tokens are marked as used; presenting one again after a short grace period revokes the whole login
  (token family). An hourly job removes expired tokens and used ones older than 24 hours.
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
npm run docker:db      # starts only Postgres via Docker Compose (docker-compose.yml + docker-compose.dev.yml)
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
| `LOG_FILE` | Optional path of a log file. The logs are written there in addition to stdout, rotated daily or at 10 MB with the newest 14 files kept. The compose file sets `/app/logs/api.log` (bind mount `./api_logs`) |
| `LOG_LEVEL` | `trace`, `debug`, `info`, `warn`, `error` or `fatal` |
| `ACCESS_TOKEN_SECRET` | Signs the JWT access tokens. In production at least 32 characters and no placeholder are required, otherwise the API does not start (e.g. `openssl rand -base64 48`) |
| `ACCESS_TOKEN_TTL` | Lifetime of the access token as a number with a unit (`s`, `m`, `h`, `d`, `w`, `y`), default `15m` |
| `REFRESH_TOKEN_TTL` / `REFRESH_TOKEN_TTL_MS` | Lifetime of the refresh token (`REFRESH_TOKEN_TTL_MS` is used) |
| `BCRYPT_SALT_ROUNDS` | Cost factor for bcrypt (min. 8) |
| `REFRESH_TOKEN_MAX_PER_USER` | Maximum number of active refresh tokens (logins on different devices) per user, default `6`; the oldest are removed |
| `TRUST_PROXY` | Number of reverse proxies in front of the API (default `0`). Needed so the rate limits use the real client IP; do not set it without a proxy |
| `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_MS` | Failed login attempts per IP within the window (default `10` per 15 minutes) |
| `REGISTER_RATE_LIMIT_MAX` / `REGISTER_RATE_LIMIT_WINDOW_MS` | Registrations per IP within the window (default `5` per hour) |
| `DOCKER_OPERATION_RATE_LIMIT_MAX` / `DOCKER_OPERATION_RATE_LIMIT_WINDOW_MS` | Docker operations (pull, deploy, restart) per IP within the window (default `10` per 15 minutes) |
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
| `npm run docker:db` / `docker:up` / `docker:adminer` | Start only Postgres / the whole stack with a locally built API image / Adminer (development) |
| `npm run docker:down` / `docker:logs` / `docker:restart` / `docker:reset` | Stop the services / follow the Postgres logs / restart Postgres / recreate the containers (does not delete `postgres_data`) |

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
| `/admin` | Only for the roles `admin` and `deployer`, see [Docker operations](#docker-operations-in-progress) |

Permissions (`todos:read`, `users:delete`, ...) are defined in `src/modules/authorization/permissions.ts`.

| Role | Permissions |
|---|---|
| `user` | Own todos, comments and profile (default role of every account) |
| `admin` | `admin:all` and `users:list`. `admin:all` grants every permission **except** the docker ones |
| `deployer` | Only the docker operations: `admin:docker:status`, `admin:docker:logs`, `admin:docker:pull`, `admin:docker:deploy`, `admin:docker:restart` |

Controlling docker gives full control over the NAS, so these permissions are never covered by `admin:all` and have
to be granted with the role `deployer` (roles are combined, a deployer usually also has the role `user` or `admin`).
Assign it in the database, e.g. with Adminer:

```sql
INSERT INTO user_roles (user_id, role_id)
SELECT u.user_id, r.role_id FROM users u, roles r WHERE u.email = '<email>' AND r.name = 'deployer';
```

Routes of the admin area check the permissions against the database on every request (`requireFreshPermissions`),
so a revoked role takes effect immediately and not only when the access token expires.

### Docker operations (in progress)

The api never talks to docker itself. Operations that change the containers (`pull` and `deploy` of an api version,
`restart` of the api) are queued in the table `deployments` (`src/modules/admin/DeploymentService.ts`), a separate
updater container will execute them one after another. Only one operation can be queued or running at a time, which
the database enforces with a unique index. Only released versions (`1.2.3`) can be pulled or deployed.

| Route | Permission | Description |
|---|---|---|
| `GET /api/admin/version` | `admin:docker:status` | Version of the running api |
| `GET /api/admin/deployments?limit=20` | `admin:docker:status` | History of the operations, newest first, without output (`limit` 1-100) |
| `GET /api/admin/deployments/:deploymentId` | `admin:docker:status` | One operation including the end of its command output |
| `POST /api/admin/deployments/pull` | `admin:docker:pull` | Body `{ "tag": "1.2.3" }`, pulls the api image of that version |
| `POST /api/admin/deployments/deploy` | `admin:docker:deploy` | Body `{ "tag": "1.2.3" }`, switches the api to that version (update and rollback) |
| `POST /api/admin/deployments/restart` | `admin:docker:restart` | No body, restarts the api container |

The `POST` routes answer `202` with the queued operation and its status url in the `Location` header, `409` while
another operation is queued or running, and are limited per IP (`DOCKER_OPERATION_RATE_LIMIT_MAX`). The updater that
executes the operations is not built yet, so for now they stay queued.

## Docker

There are two compose files, so development and production stay strictly separated:

| File | Purpose |
|---|---|
| `docker-compose.yml` | **Base, safe for production (NAS):** Postgres without a host port, Adminer on demand, the API from GHCR in a fixed version |
| `docker-compose.dev.yml` | **Development only:** publishes Postgres on `127.0.0.1:5432` and builds the API image locally. Never copy it to the NAS |

The `npm run docker:*` scripts always use both files.

### Development
- `npm run docker:db` starts only Postgres; the API runs on the host with `npm run dev`. In `.env` the `DATABASE_URL`
  must use `localhost` as host (not `postgres`, that name only exists inside of the compose network).
- `npm run docker:up` starts the whole stack including an API image built from the local `Dockerfile`
  (tag `API_IMAGE_TAG=local` in `.env`). Do not run it together with `npm run dev`, both use port 3000.
- `npm run docker:adminer` starts Adminer on `http://localhost:8080` (server `postgres`, user and password from `.env.database`).

### Production (NAS)
- Copy `docker-compose.yml`, `.env.api` and `.env.database` to the NAS (not `docker-compose.dev.yml` and not the
  development `.env`). The image `ghcr.io/cpietsch82/todo-api` is private, so run `docker login ghcr.io` once with an
  access token that has `read:packages`.
- The version of the API image is `API_IMAGE_TAG` in `.env.api`. Docker Compose reads variables for the compose file
  from the `--env-file`, not from the `env_file` of a service, so start every command with it:
  `docker compose --env-file .env.api up -d` (alternatively `export COMPOSE_ENV_FILES=.env.api`). Without a tag the
  command stops with a clear message, there is no implicit `latest`.
- **Update:** release a new version (the CI pushes the image), set the new `API_IMAGE_TAG` in `.env.api`, then
  `docker compose --env-file .env.api pull && docker compose --env-file .env.api up -d`.
  **Rollback:** set the old tag and run the same commands.
- **Adminer** is only started on demand: `docker compose --env-file .env.api --profile tools up -d adminer`, and stopped
  afterwards with `docker compose --env-file .env.api stop adminer`. Open it through an SSH tunnel, e.g.
  `ssh -L 8080:127.0.0.1:8080 user@nas`, then visit `http://localhost:8080`.
- The data of Postgres (`./postgres_data`) and the logs of the API (`./api_logs`) are bind mounts, so they are normal
  folders next to the compose file. The API runs as the user `node` (uid 1000), so `api_logs` must be writable for it
  (if the API only logs to stdout, run `chown 1000:1000 api_logs` once).

### Container
- **Ports:** Postgres and Adminer are never reachable from the network (Adminer only on `127.0.0.1`), the API
  (`3000`) is. The API reaches Postgres through the compose network.
- **API container:** runs as the unprivileged user `node`, without Linux capabilities and with `no-new-privileges`.
  The image has a `HEALTHCHECK` on `/api/health`, so `docker ps` shows whether the API is healthy.

### Logs

The API always logs to stdout (`docker compose logs -f api`). If `LOG_FILE` is set (the compose file sets
`/app/logs/api.log`), the logs are also written to a rotated file: `api.log` becomes `api.<date>.<number>.log`,
a new file is started every day or at 10 MB, the newest 14 files are kept and `current.log` always points to the active
one. Older files are removed, also those of earlier container runs, so the log directory must only contain these logs.

In Docker the directory `/app/logs` is the bind mount `./api_logs`, so the files stay available after a restart or update
and can be read on the NAS directly (`tail -n 100 api_logs/current.log`). If the file cannot be written, the API
starts anyway and only logs to stdout. Secrets and the values of database queries are removed from the logs.

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

## Authentication

- Access tokens are JWTs signed with HS256 and carry `iss`, `aud` and `sub` (the user id). They are only accepted when
  algorithm, issuer, audience, expiry and the structure of the claims are correct.
- The header has to be `Authorization: Bearer <token>`. A missing, invalid or expired token means "not authenticated":
  public routes (login, refresh, health, ...) keep working, protected routes answer `401` with
  `WWW-Authenticate: Bearer error="invalid_token"`, which is the signal for a client to refresh.
- `POST /auth/logout` only needs the refresh token in the body, no access token, so a client with an expired access token
  can still end its session on the server.

## Request Limits

- The middleware order in `ExpressAPI` is: security headers, CORS, request id, logging, **rate limit**, compression,
  **body parsing**. Throttled requests are rejected before their body is parsed.
- Only JSON bodies are accepted, bigger than 100 kb are answered with `413`.
- `/api` has a general limit per IP (`RATE_LIMIT_PER_IP`), `/auth/login` (failed attempts only) and `/auth/register`
  have stricter limits. All counters are held in memory, so they are valid per instance and reset on restart.
- Behind a reverse proxy set `TRUST_PROXY` to the number of proxies (usually `1`), otherwise all clients share the IP of
  the proxy. Never use it without a proxy: the `X-Forwarded-For` header could be forged to bypass the limits.

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
│   │   ├── rateLimit.ts            # General and stricter auth rate limiters
│   │   ├── globalErrorHandler.ts   # Error handler (status + message, error id for 5xx)
│   │   └── httpLogger.ts           # Request logging
│   ├── modules/
│   │   ├── core/
│   │   │   ├── BaseModule.ts       # Base class for all modules
│   │   │   ├── APIModule.ts        # Base class for modules that expose Express routes
│   │   │   └── StorageModule.ts    # Generic base for database backed modules
│   │   ├── express/                # ExpressAPI (app setup, routing, response helpers), VersionService
│   │   ├── authentication/         # Register, login, JWT, persistent refresh tokens and their cleanup job
│   │   ├── authorization/          # Roles, permissions and their resolution per user
│   │   ├── admin/                  # Admin API (roles admin/deployer) and the queue of the docker operations
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
├── Dockerfile / entrypoint.sh
├── docker-compose.yml              # base for production (NAS)
├── docker-compose.dev.yml          # additions for development only
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
