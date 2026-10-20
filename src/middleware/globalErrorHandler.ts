import { logger } from "@/utils/logger";
import env from "../../env";
import { randomUUID } from "crypto";
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
 * Internal (5xx) errors get a unique error id, which is logged and sent back as `X-Error-ID` header.
 * In production their message is replaced by a generic text containing this id, so no internals leak to clients,
 * but the exact error can still be looked up in the logs.
 *
 * NOTE: Express only recognizes error handlers with exactly four parameters, so `next` has to stay in the signature.
 */
export const globalErrorHandler = (messagePrefix = "") => {
  return (error: unknown, req: Request, res: Response, next: NextFunction) => {
    const httpError: HttpError = error instanceof Error ? error : new Error(String(error));
    const status = resolveStatus(httpError);

    const errorId = status >= 500 ? randomUUID() : undefined;

    const logMessage = messagePrefix ? `${messagePrefix}: ${httpError.message}` : httpError.message;
    const logContext = { errorId, err: httpError, path: req.path, method: req.method, status };
    if (status >= 500) logger.error(logContext, logMessage);
    else logger.warn(logContext, logMessage);

    // the response has already been started, so only express itself can still close the connection
    if (res.headersSent) return next(httpError);

    if (errorId) res.setHeader("X-Error-ID", errorId);

    const hideMessage = errorId && env.APP_STAGE === "production";
    const message = hideMessage
      ? `${FALLBACK_MESSAGE} (Error ID: ${errorId})`
      : httpError.message || FALLBACK_MESSAGE;
    res.respondError(message, status, true);
  };
};
