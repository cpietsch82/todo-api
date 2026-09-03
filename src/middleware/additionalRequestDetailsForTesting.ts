// import { isTestEnv } from "./../../env";
import type { Request, Response, NextFunction } from "express";

/**
 * Middleware to show request details only for test environment
 */
export const additionalRequestDetailsForTesting = async (req: Request, _res: Response, next: NextFunction) => {
  // if (isTestEnv()) {
  //   console.log("🔍 Method:", req.method);
  //   console.log("🔍 Path:", req.path);
  //   console.log("🔍 Params:", req.params);
  //   console.log("🔍 Body:", req.body);
  //   console.log("🔍 Content-Type:", req.get("Content-Type"));
  //   console.log("🔍 Headers:", req.headers);
  //   console.log("🔍 Query:", req.query);
  // }
  next();
};
