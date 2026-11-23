import dotenv from "dotenv";
import { z } from "zod";

/**
 * Module to type check the environment variables via zod schema
 */

process.env.APP_STAGE = process.env.APP_STAGE || "dev";

// const isProduction = process.env.APP_STAGE === "production";
const isDevelopment = process.env.APP_STAGE === "dev";
const isTesting = process.env.APP_STAGE === "test";

if (isDevelopment) {
  dotenv.config({ quiet: true });
} else if (isTesting) {
  dotenv.config({ quiet: true, path: "./.env.test" });
} else {
  process.env.NODE_ENV = "production"
}

// for testing the database url is not necessary,
// because we're using an in-memory database
const MIN_SECRET_LENGTH = 32;
// exact placeholder values, and anything that says "change me" (like the example value of .env.example)
const PLACEHOLDER_SECRETS = ["access_token_secret", "mytestsecret", "secret", "password"];
const CHANGE_ME_PATTERN = /change[-_ ]?me/i;

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_STAGE: z.enum(["dev", "test", "production"]).default("dev"),
  PORT: z.coerce.number().positive().default(3000),
  ALLOWED_ORIGINS: z.string().default(""),
  // optional: additionally write the logs to this file (e.g. on a docker volume), they always go to stdout as well
  LOG_FILE: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(["info", "warn", "error", "debug", "trace", "fatal"]).default("info"),
  DATABASE_URL: !isTesting ? z.string().startsWith('postgresql://') : z.string().default("YOUDONTKNOWME"),
  BCRYPT_SALT_ROUNDS: z.coerce.number().positive().min(8).default(10),
  // signs the jwt access tokens (HS256), in production at least 32 characters are required
  ACCESS_TOKEN_SECRET: isTesting ? z.string().default("myTestSecret") : z.string(),
  // lifetime of the access token as a number with a unit, e.g. 30s, 15m, 2h, 1d
  ACCESS_TOKEN_TTL: z
    .string()
    .regex(/^\d+\s?(s|m|h|d|w|y)$/, "must be a number with a unit (s, m, h, d, w or y), e.g. 15m")
    .default("15m"),
  REFRESH_TOKEN_TTL: z.string().default("7d"),
  REFRESH_TOKEN_TTL_MS: z.coerce
    .number()
    .positive()
    .default(7 * 24 * 60 * 60 * 1000),
  RATE_LIMIT_PER_IP: z.coerce.number().positive().min(100).default(1000),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().positive().default(900000), // 15 minutes
  // maximum number of active refresh tokens (= logins on different devices) per user, the oldest are removed
  REFRESH_TOKEN_MAX_PER_USER: z.coerce.number().int().positive().default(6),
  // number of reverse proxies in front of the API (0 = none). Needed for the correct client IP of the rate limits.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  // stricter limits for the authentication routes (per IP)
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10), // failed attempts
  LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().positive().default(15 * 60 * 1000),
  // failed login attempts per account (e-mail), whatever IP they come from
  LOGIN_ACCOUNT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  LOGIN_ACCOUNT_RATE_LIMIT_WINDOW_MS: z.coerce.number().positive().default(15 * 60 * 1000),
  // requests to /auth/refresh and /auth/logout (each counted separately) per IP
  TOKEN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  TOKEN_RATE_LIMIT_WINDOW_MS: z.coerce.number().positive().default(15 * 60 * 1000),
  REGISTER_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  REGISTER_RATE_LIMIT_WINDOW_MS: z.coerce.number().positive().default(60 * 60 * 1000),
  // ---- updater (only used by the updater container, see src/modules/updater) ----
  // absolute path of the folder with docker-compose.yml and deploy.env, mounted at the same path as on the host
  UPDATER_PROJECT_DIR: z.string().startsWith("/", "must be an absolute path").optional(),
  // how often the updater looks for queued operations
  UPDATER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  // how long a started api container may take to become healthy before the deploy counts as failed
  UPDATER_HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().default(3 * 60 * 1000),
  // maximum runtime of one docker command (a pull can take a while on a slow connection)
  UPDATER_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  // docker operations (pull, deploy, restart) that may be requested per IP
  DOCKER_OPERATION_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  DOCKER_OPERATION_RATE_LIMIT_WINDOW_MS: z.coerce.number().positive().default(15 * 60 * 1000),
  // developer flag: send the complete error (message and stack) in the response instead of a generic text
  EXPOSE_ERROR_DETAILS: z.stringbool().default(false),
})
  .refine((config) => !(config.APP_STAGE === "production" && config.EXPOSE_ERROR_DETAILS), {
    message: "EXPOSE_ERROR_DETAILS must not be enabled in production",
    path: ["EXPOSE_ERROR_DETAILS"],
  })
  .refine((config) => config.APP_STAGE !== "production" || config.ACCESS_TOKEN_SECRET.length >= MIN_SECRET_LENGTH, {
    message: `ACCESS_TOKEN_SECRET must have at least ${MIN_SECRET_LENGTH} characters in production (e.g. openssl rand -base64 48)`,
    path: ["ACCESS_TOKEN_SECRET"],
  })
  .refine(
    (config) =>
      config.APP_STAGE !== "production" ||
      !(PLACEHOLDER_SECRETS.includes(config.ACCESS_TOKEN_SECRET.toLowerCase()) || CHANGE_ME_PATTERN.test(config.ACCESS_TOKEN_SECRET)),
    { message: "ACCESS_TOKEN_SECRET must not be a placeholder value in production", path: ["ACCESS_TOKEN_SECRET"] },
  );

export type Env = z.infer<typeof envSchema>;

let env: Env;

try {
  env = envSchema.parse(process.env);
} catch (e) {
  if (e instanceof z.ZodError) {
    console.info("Invalid env var");
    console.error(JSON.stringify(e.issues.flat(), null, 2));

    e.issues.forEach((err) => {
      const path = err.path.join(".");
      console.info(`${path}:  ${err.message}`);
    });

    process.exit(1);
  }
  throw e;
}

export const isProdEnv = () => env.APP_STAGE === "production";
export const isDevEnv = () => env.APP_STAGE === "dev";
export const isTestEnv = () => env.APP_STAGE === "test";

export { env };
export default env;
