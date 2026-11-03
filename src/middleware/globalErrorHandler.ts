import { logger } from "@/utils/logger";
import env from "../../env";
import { HttpError } from "@/utils/HttpError";
import { isForeignKeyViolation, isUniqueViolation } from "@/utils/dbErrors";
import { randomUUID } from "crypto";
import { STATUS_CODES } from "http";
import type { NextFunction, Request, Response } from "express";

type ErrorWithStatus = Error & { status?: unknown; statusCode?: unknown; expose?: unknown };

const FALLBACK_STATUS = 500;

interface ResolvedError {
  status: number;
  /** message that may be sent to the client, undefined when the real message has to stay internal */
  publicMessage?: string;
}

/**
 * Decides which status code to use and which message may be shown to the client.
 * Only deliberately created messages are exposed: HttpErrors, known database constraint violations and
 * client errors which flag themselves with `expose` (e.g. body-parser).
 */
function resolveError(error: ErrorWithStatus): ResolvedError {
  if (error instanceof HttpError) return { status: error.status, publicMessage: error.message };

  if (isUniqueViolation(error)) return { status: 409, publicMessage: "Resource already exists" };
  if (isForeignKeyViolation(error)) return { status: 400, publicMessage: "Referenced resource does not exist" };

  const rawStatus = error.status ?? error.statusCode;
  const status =
    typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
      ? rawStatus
      : FALLBACK_STATUS;

  return { status, publicMessage: error.expose === true && status < 500 ? error.message : undefined };
}

/**
 * Sends the response via the response helpers of the ExpressAPI, so the response format is defined in one place.
 */
function respond(res: Response, status: number, message: string) {
  switch (status) {
    case 400:
      return res.respondBadRequest(message);
    case 401:
      return res.respondAuthorizationRequired(message, true);
    case 403:
      return res.respondAuthorizationInsufficient(message, true);
    case 404:
      return res.respondNotFound(message);
    case 409:
      return res.respondConflict(message);
    case 429:
      return res.respondTooManyRequests(message);
    case 500:
      return res.respondInternalServerError(message);
    case 503:
      return res.respondServiceUnavailable(message);
    default:
      return res.respondError(message, status, true);
  }
}

/**
 * Express error handler: responds with the status code of the error and a message that is safe for clients.
 * Internal (5xx) errors get a unique error id, which is logged and sent back as `X-Error-ID` header, so the exact
 * error can be looked up in the logs. The real message of an unexpected error is never sent to the client, unless the
 * developer flag EXPOSE_ERROR_DETAILS is enabled (not possible in production).
 *
 * NOTE: Express only recognizes error handlers with exactly four parameters, so `next` has to stay in the signature.
 */
export const globalErrorHandler = (messagePrefix = "") => {
  return (error: unknown, req: Request, res: Response, next: NextFunction) => {
    const caughtError: ErrorWithStatus = error instanceof Error ? error : new Error(String(error));
    const { status, publicMessage } = resolveError(caughtError);
    const errorId = status >= 500 ? randomUUID() : undefined;

    const logMessage = messagePrefix ? `${messagePrefix}: ${caughtError.message}` : caughtError.message;
    const logContext = { errorId, err: caughtError, path: req.path, method: req.method, status };
    if (status >= 500) logger.error(logContext, logMessage);
    else logger.warn(logContext, logMessage);

    // the response has already been started, so only express itself can still close the connection
    if (res.headersSent) return next(caughtError);

    if (errorId) res.setHeader("X-Error-ID", errorId);

    let message: string;
    if (env.EXPOSE_ERROR_DETAILS && !(caughtError instanceof HttpError)) {
      message = `${caughtError.message}\n\n${caughtError.stack ?? ""}`.trim();
    } else if (publicMessage !== undefined) {
      message = publicMessage;
    } else {
      const statusText = STATUS_CODES[status] ?? "Error";
      message = errorId ? `${statusText} (Error ID: ${errorId})` : statusText;
    }

    respond(res, status, message);
  };
};
