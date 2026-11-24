import rateLimit, { type Options, type RateLimitRequestHandler } from "express-rate-limit";
import env from "../../env";
import { logger } from "@/utils/logger";

export interface RateLimiterOptions {
  windowMs: number;
  limit: number;
  message?: string;
  /** only count requests which ended with a status >= 400, e.g. to throttle failed logins only */
  skipSuccessfulRequests?: boolean;
  /** what the requests are counted by, the client IP when not given */
  keyGenerator?: Options["keyGenerator"];
}

/**
 * Creates a rate limiter which answers with the 429 response helper of the ExpressAPI.
 * The counters are held in memory, so they are valid per instance and reset on restart.
 */
export function createRateLimiter({
  windowMs,
  limit,
  message = "Too many requests from this IP, please try again later.",
  skipSuccessfulRequests = false,
  keyGenerator,
}: RateLimiterOptions): RateLimitRequestHandler {
  return rateLimit({
    windowMs,
    limit,
    skipSuccessfulRequests,
    ...(keyGenerator && { keyGenerator }),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn({ ip: req.ip, path: req.originalUrl, method: req.method }, "Rate limit exceeded");
      res.respondTooManyRequests(message);
    },
  });
}

/** General limit for every api request per IP. */
export const createApiRateLimiter = () =>
  createRateLimiter({ windowMs: env.RATE_LIMIT_WINDOW_MS, limit: env.RATE_LIMIT_PER_IP });

/** Brute force protection: only failed login attempts are counted. */
export const createLoginRateLimiter = () =>
  createRateLimiter({
    windowMs: env.LOGIN_RATE_LIMIT_WINDOW_MS,
    limit: env.LOGIN_RATE_LIMIT_MAX,
    skipSuccessfulRequests: true,
    message: "Too many login attempts, please try again later.",
  });

/**
 * Brute force protection per account: failed login attempts are counted per e-mail, so an attacker with many IPs
 * cannot try passwords endlessly. E-mails without an account are counted the same way, so the block does not reveal
 * which accounts exist. Has to run after validateBody(loginSchema), which normalizes the e-mail (trim, lowercase).
 */
export const createLoginAccountRateLimiter = () =>
  createRateLimiter({
    windowMs: env.LOGIN_ACCOUNT_RATE_LIMIT_WINDOW_MS,
    limit: env.LOGIN_ACCOUNT_RATE_LIMIT_MAX,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `login-account:${String(req.body?.email)}`,
    message: "Too many login attempts, please try again later.",
  });

/** Limits the docker operations (pull, deploy, restart) per IP. */
export const createDockerOperationRateLimiter = () =>
  createRateLimiter({
    windowMs: env.DOCKER_OPERATION_RATE_LIMIT_WINDOW_MS,
    limit: env.DOCKER_OPERATION_RATE_LIMIT_MAX,
    message: "Too many docker operations from this IP, please try again later.",
  });

/**
 * Limits the token routes (refresh, logout) per IP. Every request counts. A normal client refreshes about once per
 * access token lifetime and page load, so the limit is far above normal use. Each route gets its own counter, so a
 * client that used up its refreshes can still log out.
 */
export const createTokenRateLimiter = () =>
  createRateLimiter({
    windowMs: env.TOKEN_RATE_LIMIT_WINDOW_MS,
    limit: env.TOKEN_RATE_LIMIT_MAX,
    message: "Too many token requests from this IP, please try again later.",
  });

/** Limits the creation of accounts per IP. */
export const createRegisterRateLimiter = () =>
  createRateLimiter({
    windowMs: env.REGISTER_RATE_LIMIT_WINDOW_MS,
    limit: env.REGISTER_RATE_LIMIT_MAX,
    message: "Too many registrations from this IP, please try again later.",
  });
