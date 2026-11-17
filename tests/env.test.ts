import { describe, it, expect } from "vitest";
import { envSchema } from "../env";

// The input is built completely here and does not use process.env. Otherwise the result would depend on the files and
// variables of the machine (e.g. a local .env.test) and differ between a developer machine and the CI.
const baseEnv = {
  APP_STAGE: "dev",
  DATABASE_URL: "postgresql://user:password@localhost:5432/db",
  // long enough for the production rule, so tests of other settings are not affected by it
  ACCESS_TOKEN_SECRET: "a-test-secret-with-more-than-32-characters",
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

describe("env ACCESS_TOKEN_SECRET", () => {
  const strongSecret = "x".repeat(32);
  const production = { ...baseEnv, APP_STAGE: "production" };

  it("should be accepted in production with at least 32 characters", () => {
    expect(envSchema.safeParse({ ...production, ACCESS_TOKEN_SECRET: strongSecret }).success).toBe(true);
  });

  it("should be rejected in production when it is too short", () => {
    const result = envSchema.safeParse({ ...production, ACCESS_TOKEN_SECRET: "x".repeat(31) });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(["ACCESS_TOKEN_SECRET"]);
  });

  it.each(["access_token_secret", "ChangeMe", "secret", "change-me-to-a-long-random-value-in-production"])("should reject the placeholder %s in production", (value) => {
    const result = envSchema.safeParse({ ...production, ACCESS_TOKEN_SECRET: value });

    expect(result.success).toBe(false);
  });

  it("should accept a long secret that only starts with a placeholder word", () => {
    // exact placeholders are rejected, a long random secret that happens to start with one is fine
    expect(envSchema.safeParse({ ...production, ACCESS_TOKEN_SECRET: `secret${"y".repeat(40)}` }).success).toBe(true);
  });

  it("should allow a short secret in development", () => {
    expect(envSchema.safeParse({ ...baseEnv, APP_STAGE: "dev", ACCESS_TOKEN_SECRET: "short" }).success).toBe(true);
  });

  it("should not require the unused REFRESH_TOKEN_SECRET anymore", () => {
    const withoutRefreshSecret: Record<string, string | undefined> = { ...baseEnv, ACCESS_TOKEN_SECRET: strongSecret };
    delete withoutRefreshSecret.REFRESH_TOKEN_SECRET;

    expect(envSchema.safeParse(withoutRefreshSecret).success).toBe(true);
  });
});

describe("env ACCESS_TOKEN_TTL", () => {
  it.each(["30s", "15m", "2h", "1d", "1 d"])("should accept %s", (ttl) => {
    expect(envSchema.safeParse({ ...baseEnv, ACCESS_TOKEN_TTL: ttl }).success).toBe(true);
  });

  it.each(["15", "abc", "m15", "15 minutes", "-5m", ""])("should reject %j", (ttl) => {
    const result = envSchema.safeParse({ ...baseEnv, ACCESS_TOKEN_TTL: ttl });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(["ACCESS_TOKEN_TTL"]);
  });
});

