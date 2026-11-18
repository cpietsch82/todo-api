import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import env from "../../env";
import { logger } from "@/utils/logger";

export interface RateLimiterOptions {
  windowMs: number;
  limit: number;
  message?: string;
  /** only count requests which ended with a status >= 400, e.g. to throttle failed logins only */
  skipSuccessfulRequests?: boolean;
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
}: RateLimiterOptions): RateLimitRequestHandler {
  return rateLimit({
    windowMs,
    limit,
    skipSuccessfulRequests,
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

/** Limits the docker operations (pull, deploy, restart) per IP. */
export const createDockerOperationRateLimiter = () =>
  createRateLimiter({
    windowMs: env.DOCKER_OPERATION_RATE_LIMIT_WINDOW_MS,
    limit: env.DOCKER_OPERATION_RATE_LIMIT_MAX,
    message: "Too many docker operations from this IP, please try again later.",
  });

/** Limits the creation of accounts per IP. */
export const createRegisterRateLimiter = () =>
  createRateLimiter({
    windowMs: env.REGISTER_RATE_LIMIT_WINDOW_MS,
    limit: env.REGISTER_RATE_LIMIT_MAX,
    message: "Too many registrations from this IP, please try again later.",
  });
