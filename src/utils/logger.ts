import env, { isDevEnv } from "../../env";
import pino from "pino";
import fs from "node:fs";
import path from "node:path";

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

/**
 * Checks that the log file can be written and creates its directory. Returns undefined (and tells so on stderr)
 * when that is not possible, so a missing or read-only log volume never prevents the api from starting.
 */
export function resolveLogFile(logFile: string | undefined): string | undefined {
  if (!logFile) return undefined;

  try {
    const directory = path.dirname(path.resolve(logFile));
    fs.mkdirSync(directory, { recursive: true });
    fs.accessSync(directory, fs.constants.W_OK);
    return logFile;
  } catch (error) {
    process.stderr.write(
      `LOG_FILE ${logFile} is not writable, logging to stdout only: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return undefined;
  }
}

export interface LogRotationOptions {
  /** maximum size of one log file before a new one is started, e.g. "10m" */
  size: string;
  /** how often a new log file is started at the latest */
  frequency: "daily" | "hourly";
  /** number of rotated files that are kept in addition to the active one */
  count: number;
}

export const DEFAULT_LOG_ROTATION: LogRotationOptions = { size: "10m", frequency: "daily", count: 14 };

const PRETTY_TARGET = {
  target: "pino-pretty",
  options: {
    colorize: true,
    translateTime: "HH:MM:ss Z",
    ignore: "pid,hostname",
  },
};

/**
 * Target of the rotated log file: api.log becomes api.<date>.<number>.log, the symlink current.log always points to the
 * active file. Old files are removed, also those of earlier runs, so the directory of the log file should be used for
 * the logs only.
 */
export function buildFileTarget(logFile: string, rotation: LogRotationOptions = DEFAULT_LOG_ROTATION) {
  return {
    target: "pino-roll",
    options: {
      file: logFile,
      mkdir: true,
      dateFormat: "yyyy-MM-dd",
      frequency: rotation.frequency,
      size: rotation.size,
      symlink: true,
      limit: { count: rotation.count, removeOtherLogFiles: true },
    },
  };
}

/**
 * Builds the destination of the logger. Without a log file production logs go straight to stdout (undefined = pino
 * default), development uses pino-pretty. With a log file they go to the console and to the rotated file.
 *
 * A multistream is used instead of `transport.targets`, because pino does not allow the custom level formatter
 * (INFO instead of 30) together with several transport targets.
 */
export function buildDestination(
  logFile: string | undefined,
  development: boolean,
  rotation: LogRotationOptions = DEFAULT_LOG_ROTATION,
): pino.DestinationStream | undefined {
  const consoleStream = development ? pino.transport(PRETTY_TARGET) : undefined;
  if (!logFile) return consoleStream;

  // the level of the logger decides what is logged, so the streams must accept everything
  return pino.multistream([
    { level: "trace", stream: consoleStream ?? process.stdout },
    { level: "trace", stream: pino.transport(buildFileTarget(logFile, rotation)) },
  ]);
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
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
  },
};

export const logger = pino(loggerOptions, buildDestination(resolveLogFile(env.LOG_FILE), isDevEnv()));
