import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { loggerOptions, serializeError } from "@/utils/logger";
import { generateUser } from "@tests/test.helpers";
// registers the database cleanup hooks (users are removed after each test)
import "@tests/integration.setup";

/** creates a logger with the production options which collects everything it writes */
function createCollectingLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });

  return { log: pino({ ...loggerOptions, transport: undefined }, stream), output: () => lines.join("") };
}

function createDrizzleLikeError(params: unknown[]) {
  const query = 'insert into "users" ("email", "username") values ($1, $2)';
  const error = new Error(`Failed query: ${query}\nparams: ${params}`, {
    cause: Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      detail: `Key (email)=(${params[0]}) already exists.`,
    }),
  });

  return Object.assign(error, { query, params });
}

describe("logger", () => {
  describe("serializeError", () => {
    it("should remove the query parameters from message, stack and properties", () => {
      const result = serializeError(createDrizzleLikeError(["secret@mail.com", "secretuser"])) as Record<string, unknown>;
      const text = JSON.stringify(result);

      expect(text).not.toContain("secret@mail.com");
      expect(text).not.toContain("secretuser");
      expect(result.params).toBeUndefined();
      expect(result.message).toContain("params: [REDACTED]");
    });

    it("should keep the query text and the database error message", () => {
      const result = serializeError(createDrizzleLikeError(["secret@mail.com", "secretuser"])) as Record<string, string>;

      expect(result.message).toContain('insert into "users"');
      expect(result.message).toContain("duplicate key value violates unique constraint");
      expect(result.type).toBe("Error");
      expect(result.stack).toContain("at ");
    });

    it("should remove parameters that span multiple lines", () => {
      const result = serializeError(createDrizzleLikeError(["line one\nline two with secret", "x"]));

      expect(JSON.stringify(result)).not.toContain("secret");
    });

    it("should remove the parameters of a wrapped error as well", () => {
      const wrapped = new Error("Email or username already in use", { cause: createDrizzleLikeError(["secret@mail.com", "x"]) });

      expect(JSON.stringify(serializeError(wrapped))).not.toContain("secret@mail.com");
    });

    it("should not change errors without query parameters", () => {
      const result = serializeError(new Error("plain failure")) as Record<string, string>;

      expect(result.message).toBe("plain failure");
      expect(result.stack).toContain("plain failure");
    });

    it("should not touch short parameters inside unrelated text", () => {
      const error = createDrizzleLikeError([1]);
      error.message = `Failed query: select 1 from users where id = $1\nparams: 1`;

      const result = serializeError(error) as Record<string, string>;

      expect(result.message).toContain("select 1 from users");
      expect(result.message).toContain("params: [REDACTED]");
    });

    it("should handle values that are not an error", () => {
      expect(() => serializeError("text")).not.toThrow();
      expect(() => serializeError(undefined)).not.toThrow();
    });
  });

  describe("redaction of secrets", () => {
    it("should censor secrets which are logged as part of an object", () => {
      const { log, output } = createCollectingLogger();

      log.info({ password: "hunter2", user: { refreshToken: "abc123", name: "alice" }, req: { headers: { authorization: "Bearer xyz" } } }, "test");

      expect(output()).not.toContain("hunter2");
      expect(output()).not.toContain("abc123");
      expect(output()).not.toContain("Bearer xyz");
      expect(output()).toContain("alice");
    });
  });

  describe("real database error", () => {
    it("should not log the values of a failed insert", async () => {
      const existing = await generateUser({ email: "leaky.address@test.com", username: "leakyusername" });
      const { log, output } = createCollectingLogger();

      let caught: unknown;
      try {
        await db.insert(users).values({ email: existing.email, username: "anotherusername" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      // without the serializer the values would be part of the log, so this test really proves the redaction
      expect(JSON.stringify(pino.stdSerializers.err(caught as Error))).toContain("leaky.address@test.com");

      log.error({ err: caught }, "insert failed");

      expect(output()).toContain("insert failed");
      expect(output()).toContain("duplicate key");
      expect(output()).not.toContain("leaky.address@test.com");
      expect(output()).not.toContain("anotherusername");
      expect(await db.select().from(users).where(eq(users.userId, existing.userId))).toHaveLength(1);
    });
  });
});
