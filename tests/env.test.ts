import { describe, it, expect } from "vitest";
import { envSchema } from "../env";

const baseEnv = {
  ...process.env,
  APP_STAGE: "dev",
  DATABASE_URL: "postgresql://user:password@localhost:5432/db",
};

describe("env EXPOSE_ERROR_DETAILS", () => {
  it("should be disabled by default", () => {
    const withoutFlag: Record<string, string | undefined> = { ...baseEnv };
    delete withoutFlag.EXPOSE_ERROR_DETAILS;

    const result = envSchema.safeParse(withoutFlag);

    expect(result.success).toBe(true);
    expect(result.data?.EXPOSE_ERROR_DETAILS).toBe(false);
  });

  it("should be enabled by the string true", () => {
    const result = envSchema.safeParse({ ...baseEnv, EXPOSE_ERROR_DETAILS: "true" });

    expect(result.success).toBe(true);
    expect(result.data?.EXPOSE_ERROR_DETAILS).toBe(true);
  });

  it("should reject values that are not a boolean", () => {
    const result = envSchema.safeParse({ ...baseEnv, EXPOSE_ERROR_DETAILS: "maybe" });

    expect(result.success).toBe(false);
  });

  it("should refuse to start in production when enabled", () => {
    const result = envSchema.safeParse({ ...baseEnv, APP_STAGE: "production", EXPOSE_ERROR_DETAILS: "true" });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(["EXPOSE_ERROR_DETAILS"]);
  });

  it("should be accepted in production when disabled", () => {
    const result = envSchema.safeParse({ ...baseEnv, APP_STAGE: "production", EXPOSE_ERROR_DETAILS: "false" });

    expect(result.success).toBe(true);
  });
});
