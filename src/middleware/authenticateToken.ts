import type { Request, Response, NextFunction, RequestHandler } from "express";
import TokenService, { type JwtPayload } from "@/modules/authentication/TokenService";

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

export function createAuthMiddleware(tokenService: TokenService): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        req.authenticated = false;
      } else {
        const token = authHeader && authHeader.split(" ")[1];
        const payload = await tokenService.verifyAccessToken(token);

        req.user = payload;
        req.authenticated = true;
      }
      next();
    } catch (error: Error | unknown) {
      console.error("Authentication error:", error);
      return res.respondAuthorizationInsufficient();
    }
  };
}

// TODO: try to find another or better name for this function
// AND check where i can fit the verifyToken method at best
// export const authenticated = async (req: Request, res: Response, next: NextFunction) => {
//   const authHeader = req.headers.authorization;
//   const token = authHeader && authHeader.split(" ")[1];
//   req.authenticated = !!token;
//   next();
// };

// export const validateAuthenticationToken = async (req: Request, res: Response, next: NextFunction) => {
//   console.log("validateAuthenticationToken authenticated?", req.authenticated);

//   if (!req.authenticated) return res.respondAuthorizationRequired();
//   next();
// };
