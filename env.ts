import dotenv from "dotenv";
import { z } from "zod";

/**
 * Module to type check the environment variables via zod schema
 */

process.env.APP_STAGE = process.env.APP_STAGE || "dev";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const isProduction = process.env.APP_STAGE === "production";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const isDevelopment = process.env.APP_STAGE === "dev";
const isTesting = process.env.APP_STAGE === "test";

if (isDevelopment) {
  dotenv.config({ quiet: true });
} else if (isTesting) {
  dotenv.config({ quiet: true, path: "./.env.test" });
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_STAGE: z.enum(["dev", "test", "production"]).default("dev"),
  PORT: z.coerce.number().positive().default(3000),
  ALLOWED_ORIGINS: z.string(),
  LOG_LEVEL: z.enum(["info", "warn", "error", "debug", "trace", "fatal"]),
  DATABASE_URL: z.string(), // maybe .startsWith('postgresql://')
  JWT_SECRET: z.string().min(32, "Must be 32 chars long"),
  JWT_EXPIRES_IN: z.string().default("7d"),
  BCRYPT_SALT_ROUNDS: z.coerce.number().positive().min(8),
  ACCESS_TOKEN_SECRET: z.string(),
  REFRESH_TOKEN_SECRET: z.string(),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL: z.string().default("7d"),
  REFRESH_TOKEN_TTL_MS: z.coerce
    .number()
    .positive()
    .default(7 * 24 * 60 * 60 * 1000),
  RATE_LIMIT_PER_IP: z.coerce.number().positive().min(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().positive().default(900000), // 15 minutes
});

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
