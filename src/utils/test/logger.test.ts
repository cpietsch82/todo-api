import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { buildDestination, buildFileTarget, loggerOptions, resolveLogFile, serializeError } from "@/utils/logger";
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

  describe("log file", () => {
    const tempDirs: string[] = [];
    const openStreams: { end: () => void }[] = [];
    const createTempDir = () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "todo-api-logs-"));
      tempDirs.push(directory);
      return directory;
    };
    /** a transport that only writes to the rotated file (see the note about the stdout descriptor below) */
    const createFileTransport = (logFile: string, rotation?: Parameters<typeof buildFileTarget>[1]) => {
      const transport = pino.transport(buildFileTarget(logFile, rotation));
      openStreams.push(transport);
      return transport;
    };

    afterEach(() => {
      vi.restoreAllMocks();
      for (const stream of openStreams.splice(0)) stream.end();
      for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
    });

    it("should not use a log file when none is configured", () => {
      expect(resolveLogFile(undefined)).toBeUndefined();
      expect(buildDestination(undefined, false)).toBeUndefined();
    });

    it("should create the directory of the log file", () => {
      const file = path.join(createTempDir(), "nested", "api.log");

      expect(resolveLogFile(file)).toBe(file);
      expect(fs.existsSync(path.dirname(file))).toBe(true);
    });

    it("should fall back to stdout only and tell so when the log file cannot be written", () => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      // a directory below a regular file can never be created
      const blocker = path.join(createTempDir(), "blocker");
      fs.writeFileSync(blocker, "x");

      expect(resolveLogFile(path.join(blocker, "api.log"))).toBeUndefined();
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("not writable"));
    });

    it("should rotate daily or at 10 MB, keep 14 files and link the active one by default", () => {
      expect(buildFileTarget("/app/logs/api.log")).toEqual({
        target: "pino-roll",
        options: {
          file: "/app/logs/api.log",
          mkdir: true,
          dateFormat: "yyyy-MM-dd",
          frequency: "daily",
          size: "10m",
          symlink: true,
          limit: { count: 14, removeOtherLogFiles: true },
        },
      });
    });

    it("should use the given rotation settings", () => {
      const { options } = buildFileTarget("/x/api.log", { size: "1k", frequency: "hourly", count: 3 });

      expect(options).toMatchObject({ size: "1k", frequency: "hourly", limit: { count: 3 } });
    });

    // This is the setup of the real logger. It is a separate test, because pino refuses the level formatter of
    // loggerOptions together with several transport targets, which only shows when the options are really used.
    it("should write the real logger to the console and to the file in the same format", async () => {
      const directory = createTempDir();
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const destination = buildDestination(path.join(directory, "api.log"), false) as unknown as {
        streams: { stream: { end: () => void } }[];
      };
      destination.streams.filter(({ stream }) => stream !== (process.stdout as unknown)).forEach(({ stream }) => openStreams.push(stream));
      const log = pino({ ...loggerOptions, level: "info" }, destination as unknown as pino.DestinationStream);

      log.info({ password: "hunter2" }, "written to both");
      log.error({ err: createDrizzleLikeError(["secret@mail.com", "x"]) }, "failed");

      const currentLog = path.join(directory, "current.log");
      await vi.waitFor(() => expect(fs.readFileSync(currentLog, "utf8")).toContain("failed"), { timeout: 5000 });
      const content = fs.readFileSync(currentLog, "utf8");
      expect(content).toContain('"level":"INFO"');
      expect(content).toContain('"level":"ERROR"');
      expect(content).toContain("written to both");
      expect(content).not.toContain("hunter2");
      expect(content).not.toContain("secret@mail.com");
      expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("written to both");
    });

    it("should keep the pretty printing in development", () => {
      const destination = buildDestination(undefined, true) as unknown as { end: () => void };
      openStreams.push(destination);

      expect(destination).toBeDefined();
    });

    it("should write the log lines into the file without secrets", async () => {
      const directory = createTempDir();
      const log = pino({ ...loggerOptions, transport: undefined }, createFileTransport(path.join(directory, "api.log")));

      log.info({ password: "hunter2" }, "written to the file");
      log.error({ err: createDrizzleLikeError(["secret@mail.com", "x"]) }, "failed");

      const currentLog = path.join(directory, "current.log");
      await vi.waitFor(() => expect(fs.readFileSync(currentLog, "utf8")).toContain("failed"), { timeout: 5000 });
      const content = fs.readFileSync(currentLog, "utf8");
      expect(content).toContain("written to the file");
      expect(content).not.toContain("hunter2");
      expect(content).not.toContain("secret@mail.com");
    });

    it("should name the files with date and number and link the active one", async () => {
      const directory = createTempDir();
      pino({}, createFileTransport(path.join(directory, "api.log"))).info("first line");

      await vi.waitFor(
        () =>
          expect(fs.readdirSync(directory).some((name) => /^api\.\d{4}-\d{2}-\d{2}\.1\.log$/.test(name))).toBe(true),
        { timeout: 5000 },
      );
      await vi.waitFor(() => expect(fs.readFileSync(path.join(directory, "current.log"), "utf8")).toContain("first line"), {
        timeout: 5000,
      });
    });

    it("should rotate by size and keep only the configured number of files", async () => {
      const directory = createTempDir();
      const transport = createFileTransport(path.join(directory, "api.log"), { size: "1k", frequency: "daily", count: 2 });
      const log = pino({}, transport);

      for (let i = 0; i < 300; i++) log.info(`line ${i} ${"x".repeat(100)}`);

      const logFiles = () => fs.readdirSync(directory).filter((name) => /^api\..*\.log$/.test(name));
      await vi.waitFor(() => expect(logFiles().length).toBeGreaterThan(1), { timeout: 5000 });
      // old files are removed, 2 rotated files + the active one remain
      await vi.waitFor(() => expect(logFiles().length).toBeLessThanOrEqual(3), { timeout: 5000 });
    });
  });
});
