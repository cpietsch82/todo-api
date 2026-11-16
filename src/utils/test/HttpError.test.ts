import { describe, it, expect } from "vitest";
import { HttpError } from "@/utils/HttpError";
import { getPgErrorCode, isForeignKeyViolation, isUniqueViolation } from "@/utils/dbErrors";

describe("HttpError", () => {
  it("should carry status and message", () => {
    const error = new HttpError(418, "teapot");

    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(418);
    expect(error.message).toBe("teapot");
    expect(error.name).toBe("HttpError");
  });

  it.each([
    ["badRequest", 400, "Bad request"],
    ["unauthorized", 401, "Authorization required!"],
    ["forbidden", 403, "Insufficient Permissions!"],
    ["notFound", 404, "Not found."],
    ["conflict", 409, "Conflict"],
  ] as const)("%s should create a %i error with a default message", (factory, status, message) => {
    const error = HttpError[factory]();

    expect(error.status).toBe(status);
    expect(error.message).toBe(message);
  });

  it("should use a custom message and keep the cause", () => {
    const cause = new Error("original");
    const error = HttpError.conflict("already taken", cause);

    expect(error.message).toBe("already taken");
    expect(error.cause).toBe(cause);
  });
});

describe("dbErrors", () => {
  it("should read the postgres code of the error itself", () => {
    expect(getPgErrorCode(Object.assign(new Error("x"), { code: "23505" }))).toBe("23505");
  });

  it("should find the postgres code in the cause chain", () => {
    const error = new Error("wrapped", { cause: Object.assign(new Error("inner"), { code: "23503" }) });

    expect(getPgErrorCode(error)).toBe("23503");
  });

  it("should ignore codes that are not postgres codes", () => {
    expect(getPgErrorCode(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBeUndefined();
  });

  it("should return undefined for values without a code", () => {
    expect(getPgErrorCode(new Error("plain"))).toBeUndefined();
    expect(getPgErrorCode("text")).toBeUndefined();
    expect(getPgErrorCode(undefined)).toBeUndefined();
  });

  it("should detect unique and foreign key violations", () => {
    const unique = Object.assign(new Error("x"), { code: "23505" });
    const foreignKey = Object.assign(new Error("x"), { code: "23503" });

    expect(isUniqueViolation(unique)).toBe(true);
    expect(isUniqueViolation(foreignKey)).toBe(false);
    expect(isForeignKeyViolation(foreignKey)).toBe(true);
    expect(isForeignKeyViolation(unique)).toBe(false);
  });
});
