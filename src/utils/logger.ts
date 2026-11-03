import env, { isDevEnv } from "../../env";
import pino from "pino";

const REDACTED = "[REDACTED]";

// properties of database errors which contain the values of a query (e.g. emails, password hashes, user texts)
const SENSITIVE_ERROR_PROPERTIES = ["params", "detail"];

/**
 * Collects the query parameters of an error and all of its causes. Drizzle appends them to the message of a
 * failed query (`...\nparams: a,b,c`) and also keeps them in the `params` property.
 */
function collectQueryParams(error: unknown): string[] {
  const collected: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const params = (current as { params?: unknown }).params;
    if (Array.isArray(params) && params.length > 0) collected.push(String(params));
    current = (current as { cause?: unknown }).cause;
  }

  return collected;
}

/**
 * Error serializer which keeps the useful parts of an error (type, message, stack, query text with its placeholders)
 * but removes the values of the query, so no emails, password hashes or other user data end up in the logs.
 */
export function serializeError(error: unknown) {
  const serialized = pino.stdSerializers.err(error as Error) as unknown as Record<string, unknown>;
  if (!serialized || typeof serialized !== "object") return serialized;

  for (const joinedParams of collectQueryParams(error)) {
    const leakingText = `\nparams: ${joinedParams}`;
    const safeText = `\nparams: ${REDACTED}`;

    for (const key of ["message", "stack"]) {
      const value = serialized[key];
      if (typeof value === "string") serialized[key] = value.split(leakingText).join(safeText);
    }
  }

  for (const property of SENSITIVE_ERROR_PROPERTIES) delete serialized[property];

  return serialized;
}

export const loggerOptions: pino.LoggerOptions = {
  level: env.LOG_LEVEL || "info",
  serializers: {
    err: serializeError,
  },
  // safety net for secrets which are logged as part of an object by accident
  redact: {
    paths: [
      "password",
      "*.password",
      "refreshToken",
      "*.refreshToken",
      "accessToken",
      "*.accessToken",
      "token",
      "*.token",
      "tokenHash",
      "*.tokenHash",
      "authorization",
      "*.authorization",
      "req.headers.authorization",
    ],
    censor: REDACTED,
  },
  transport: isDevEnv()
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss Z",
          ignore: "pid,hostname",
        },
      }
    : undefined,
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
  },
};

export const logger = pino(loggerOptions);
