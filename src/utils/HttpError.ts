/**
 * Error with an http status and a message that is safe to be shown to the client.
 *
 * Only the message of an HttpError is sent back by the global error handler,
 * the messages of all other errors stay in the logs.
 */
export class HttpError extends Error {
  public readonly status: number;

  constructor(status: number, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HttpError";
    this.status = status;
  }

  static badRequest(message = "Bad request", cause?: unknown) {
    return new HttpError(400, message, cause);
  }

  static unauthorized(message = "Authorization required!", cause?: unknown) {
    return new HttpError(401, message, cause);
  }

  static forbidden(message = "Insufficient Permissions!", cause?: unknown) {
    return new HttpError(403, message, cause);
  }

  static notFound(message = "Not found.", cause?: unknown) {
    return new HttpError(404, message, cause);
  }

  static conflict(message = "Conflict", cause?: unknown) {
    return new HttpError(409, message, cause);
  }
}

export default HttpError;
