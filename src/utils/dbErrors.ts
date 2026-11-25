// Postgres error codes, see https://www.postgresql.org/docs/current/errcodes-appendix.html
export const PG_UNIQUE_VIOLATION = "23505";
export const PG_FOREIGN_KEY_VIOLATION = "23503";
export const PG_CHECK_VIOLATION = "23514";
export const PG_SERIALIZATION_FAILURE = "40001";
export const PG_DEADLOCK_DETECTED = "40P01";

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
export const isCheckViolation = (error: unknown) => getPgErrorCode(error) === PG_CHECK_VIOLATION;

const RETRYABLE_CODES = [PG_DEADLOCK_DETECTED, PG_SERIALIZATION_FAILURE];

/** A deadlock or a serialization failure: postgres aborted the transaction, running it again may succeed. */
export const isRetryableTransactionError = (error: unknown) => RETRYABLE_CODES.includes(getPgErrorCode(error) ?? "");

/**
 * Returns the name of the constraint a postgres error is about (postgres-js calls it constraint_name, PGlite
 * constraint), searching the cause chain like getPgErrorCode.
 */
export function getPgConstraintName(error: unknown): string | undefined {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const { constraint_name: constraintName, constraint } = current as { constraint_name?: unknown; constraint?: unknown };
    const name = constraintName ?? constraint;
    if (typeof name === "string" && name.length > 0) return name;
    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

/**
 * Runs a transaction and runs it once more when postgres aborted it because of a deadlock or a serialization failure.
 * Postgres resolves a deadlock by aborting one of the transactions; running it again usually succeeds, because the
 * other one is done by then. A second failure is thrown.
 * @param run has to open a new transaction on every call, an aborted transaction cannot be used again
 */
export async function withRetryOnDeadlock<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isRetryableTransactionError(error)) throw error;
    return run();
  }
}
