import z from "zod";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const ErrorHandlerSchema = z.record(z.string(), z.function());
type ErrorHandler = z.infer<typeof ErrorHandlerSchema>;

type ExtendedError = {
  code: string;
  message: string;
  stack?: string[];
  cause?: Error;
};

class ErrorWithCode extends Error {
  private code: string;
  private cause?: Error;

  static dispatch(error: ExtendedError, handlers: ErrorHandler) {
    if (!handlers) error.message = "ErrorWithCode.dispatch requires two parameters..";
    if (handlers[error.code]) return handlers[error.code]();
    throw error;
  }

  constructor(message: string, code: string, cause?: Error) {
    super(message);
    this.code = code;
    if (cause) this.cause = cause;
  }
}

export default ErrorWithCode;
