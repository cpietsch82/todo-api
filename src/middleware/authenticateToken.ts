import type { Request, Response, NextFunction, RequestHandler } from "express";
import TokenService, { type JwtPayload } from "@/modules/authentication/TokenService";
import { logger } from "@/utils/logger";

// Declare global Request extension
// later we have to put this into a d.ts file!?
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
      authenticated: boolean;
    }
  }
}

// the only accepted form of the header is "Bearer <token>" (the scheme is case insensitive)
const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

/**
 * Identifies the user of a request, it does not reject anything: without a token, or with an invalid or expired one,
 * the request simply counts as not authenticated. Protected routes are closed by `requireAuthentication` with a 401,
 * public routes (login, refresh, health, ...) stay usable even when a client still sends an old token.
 */
export function createAuthMiddleware(tokenService: TokenService): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    req.authenticated = false;

    const authHeader = req.headers.authorization;
    if (!authHeader) return next();

    try {
      const token = BEARER_PATTERN.exec(authHeader)?.[1];
      if (!token) throw new Error("Authorization header is not a Bearer token");

      req.user = await tokenService.verifyAccessToken(token);
      req.authenticated = true;
    } catch (error: unknown) {
      // tell the client why it is not authenticated, never log the token itself
      res.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"');
      logger.warn(
        { reason: error instanceof Error ? error.message : "unknown", path: req.path, method: req.method },
        "Rejected access token",
      );
    }

    next();
  };
}
