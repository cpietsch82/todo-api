import { describe, it, expect, vi } from "vitest";
import { isCheckViolation, withRetryOnDeadlock } from "@/utils/dbErrors";

const pgError = (code: string) => Object.assign(new Error(`pg error ${code}`), { code });

describe("withRetryOnDeadlock", () => {
  it("should run again once after a deadlock", async () => {
    const run = vi.fn().mockRejectedValueOnce(pgError("40P01")).mockResolvedValueOnce("done");

    await expect(withRetryOnDeadlock(run)).resolves.toBe("done");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("should run again once after a serialization failure, also when it is wrapped", async () => {
    const wrapped = new Error("Failed query", { cause: pgError("40001") });
    const run = vi.fn().mockRejectedValueOnce(wrapped).mockResolvedValueOnce("done");

    await expect(withRetryOnDeadlock(run)).resolves.toBe("done");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("should not retry other errors", async () => {
    const run = vi.fn().mockRejectedValue(pgError("23505"));

    await expect(withRetryOnDeadlock(run)).rejects.toThrow("pg error 23505");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("should give up after the second deadlock", async () => {
    const run = vi.fn().mockRejectedValue(pgError("40P01"));

    await expect(withRetryOnDeadlock(run)).rejects.toThrow("pg error 40P01");
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("isCheckViolation", () => {
  it("should recognize a check violation, also in the cause of a failed query", () => {
    expect(isCheckViolation(pgError("23514"))).toBe(true);
    expect(isCheckViolation(new Error("Failed query", { cause: pgError("23514") }))).toBe(true);
    expect(isCheckViolation(pgError("23505"))).toBe(false);
  });
});
