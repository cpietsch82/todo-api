import { logger } from "@/utils/logger";
import env from "../../env";
import type { NextFunction, Request, Response } from "express";

type HttpError = Error & { status?: unknown; statusCode?: unknown };

const FALLBACK_STATUS = 500;
const FALLBACK_MESSAGE = "Internal Server Error";

/**
 * Picks the http status from the error (`status` / `statusCode`, as used by body-parser, http-errors etc.).
 * Falls back to 500 when the error carries no valid client / server error status.
 */
function resolveStatus(error: HttpError): number {
  const status = error.status ?? error.statusCode;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : FALLBACK_STATUS;
}

/**
 * Express error handler: responds with the status code of the error and its message as response text.
 * Internal (5xx) messages are replaced by a generic text in production, so no internals leak to clients.
 *
 * NOTE: Express only recognizes error handlers with exactly four parameters, so `next` has to stay in the signature.
 */
export const globalErrorHandler = (messagePrefix = "") => {
  return (error: unknown, req: Request, res: Response, next: NextFunction) => {
    const httpError: HttpError = error instanceof Error ? error : new Error(String(error));
    const status = resolveStatus(httpError);

    const logMessage = messagePrefix ? `${messagePrefix}: ${httpError.message}` : httpError.message;
    const logContext = { err: httpError, path: req.path, method: req.method, status };
    if (status >= 500) logger.error(logContext, logMessage);
    else logger.warn(logContext, logMessage);

    // the response has already been started, so only express itself can still close the connection
    if (res.headersSent) return next(httpError);

    const hideMessage = status >= 500 && env.APP_STAGE === "production";
    res.respondError(hideMessage ? FALLBACK_MESSAGE : httpError.message || FALLBACK_MESSAGE, status, true);
  };
};
