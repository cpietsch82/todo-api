import { logger } from "@/utils/logger";
import type { Request, Response } from "express";

export const globalErrorHandler = (messagePrefix = "") => {
  return async (error: Error, req: Request, res: Response) => { //, next: NextFunction) => {
    console.log("globalErrorHandler", error);
    logger.error({ error, path: req.path, method: req.method }, "Unhandled error");
    res.respondError(`${messagePrefix} returning with status ${res.status} due to crash: ${error.stack}`);
  };
};
