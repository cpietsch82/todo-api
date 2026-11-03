// Postgres error codes, see https://www.postgresql.org/docs/current/errcodes-appendix.html
export const PG_UNIQUE_VIOLATION = "23505";
export const PG_FOREIGN_KEY_VIOLATION = "23503";

/**
 * Returns the postgres error code of an error. Drizzle wraps the driver error in a DrizzleQueryError
 * and keeps the original one as `cause`, so the cause chain is searched as well.
 */
export function getPgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

export const isUniqueViolation = (error: unknown) => getPgErrorCode(error) === PG_UNIQUE_VIOLATION;
export const isForeignKeyViolation = (error: unknown) => getPgErrorCode(error) === PG_FOREIGN_KEY_VIOLATION;
