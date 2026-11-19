import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import AuthenticationService from "@modules/authentication/AuthenticationService";
import {
  parseCreateUserArgs,
  promptHidden,
  provisionUser,
  readFirstLine,
  UsageError,
  type CreateUserOptions,
  type HiddenInput,
} from "@/scripts/userProvisioning";
import { generateUser } from "@tests/test.helpers";
// registers the database cleanup hooks
import "@tests/integration.setup";

const PASSWORD = "a-long-secret-1";

function options(overrides: Partial<CreateUserOptions> = {}): CreateUserOptions {
  return { email: "admin@example.com", username: "admin", roles: ["user", "admin", "deployer"], ...overrides };
}

describe("parseCreateUserArgs", () => {
  it("should read all options and always add the role user", () => {
    expect(
      parseCreateUserArgs([
        "--email", " admin@example.com ",
        "--username", "admin",
        "--first-name", "Ada",
        "--last-name", "Lovelace",
        "--role", "admin",
        "--role", "deployer",
      ]),
    ).toEqual({
      email: "admin@example.com",
      username: "admin",
      firstName: "Ada",
      lastName: "Lovelace",
      roles: ["user", "admin", "deployer"],
    });
  });

  it("should accept comma separated roles and drop duplicates", () => {
    const parsed = parseCreateUserArgs(["--email", "a@example.com", "--role", "admin, deployer", "--role", "admin,user"]);

    expect(parsed).toMatchObject({ roles: ["user", "admin", "deployer"] });
  });

  it("should return help", () => {
    expect(parseCreateUserArgs(["--help"])).toBe("help");
    expect(parseCreateUserArgs(["-h"])).toBe("help");
  });

  it.each([
    ["no e-mail", ["--username", "admin"]],
    ["an unknown option", ["--email", "a@example.com", "--password", "secret"]],
    ["a positional argument", ["--email", "a@example.com", "admin"]],
    ["an option without value", ["--email"]],
  ])("should refuse %s", (_name, argv) => {
    expect(() => parseCreateUserArgs(argv)).toThrow(UsageError);
  });
});

describe("provisionUser", () => {
  it("should create a user with password and roles, who can log in", async () => {
    const readPassword = vi.fn().mockResolvedValue(PASSWORD);

    const result = await provisionUser(options({ firstName: "Ada" }), readPassword);

    expect(result).toMatchObject({
      created: true,
      email: "admin@example.com",
      addedRoles: expect.arrayContaining(["user", "admin", "deployer"]),
      roles: ["admin", "deployer", "user"],
    });
    expect(readPassword).toHaveBeenCalledTimes(1);

    const [user] = await db.select().from(users).where(eq(users.userId, result.userId));
    expect(user).toMatchObject({ username: "admin", firstName: "Ada", lastName: null });

    const login = await new AuthenticationService().login("admin@example.com", PASSWORD);
    expect(login).toBeDefined();
  });

  it("should only add the roles to an existing user and not ask for a password", async () => {
    const existing = await generateUser();
    const readPassword = vi.fn();

    const result = await provisionUser({ email: existing.email, roles: ["user", "deployer"] }, readPassword);

    expect(readPassword).not.toHaveBeenCalled();
    expect(result).toMatchObject({ created: false, userId: existing.userId, roles: ["deployer", "user"] });
    expect(result.addedRoles).toContain("deployer");
  });

  it("should report no added roles when the user already has them", async () => {
    await provisionUser(options(), async () => PASSWORD);

    const result = await provisionUser({ email: "admin@example.com", roles: ["user", "admin"] }, vi.fn());

    expect(result.addedRoles).toEqual([]);
    expect(result.roles).toEqual(["admin", "deployer", "user"]);
  });

  it("should refuse an unknown role before asking for the password and create nothing", async () => {
    const readPassword = vi.fn();

    await expect(provisionUser(options({ roles: ["user", "superuser"] }), readPassword)).rejects.toThrow(
      /Unknown role\(s\): superuser\. Known roles: .*admin/,
    );

    expect(readPassword).not.toHaveBeenCalled();
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it.each([
    ["no username", options({ username: undefined }), "--username is required"],
    ["an invalid e-mail", options({ email: "not-an-email" }), "email"],
  ])("should refuse a new user with %s before asking for the password", async (_name, input, message) => {
    const readPassword = vi.fn();

    await expect(provisionUser(input, readPassword)).rejects.toThrow(message);

    expect(readPassword).not.toHaveBeenCalled();
  });

  it("should refuse a short password", async () => {
    await expect(provisionUser(options(), async () => "short")).rejects.toThrow(/^password:/);

    expect(await db.select().from(users)).toHaveLength(0);
  });

  it("should refuse a username that is taken, without creating anything", async () => {
    const existing = await generateUser();

    await expect(provisionUser(options({ username: existing.username }), async () => PASSWORD)).rejects.toThrow(
      "Email or username already in use",
    );

    expect(await db.select().from(users)).toHaveLength(1);
  });

  it("should refuse profile fields for an existing user", async () => {
    const existing = await generateUser();

    await expect(provisionUser({ email: existing.email, username: "other", roles: ["user"] }, vi.fn())).rejects.toThrow(
      "already exists",
    );
  });
});

describe("password input", () => {
  class FakeTerminal extends EventEmitter implements HiddenInput {
    rawMode = false;
    setRawMode(mode: boolean) {
      this.rawMode = mode;
    }
    setEncoding() {}
    resume() {}
    pause() {}
    type(text: string) {
      this.emit("data", text);
    }
  }

  function prompt(terminal: FakeTerminal) {
    const written: string[] = [];
    const answer = promptHidden("Password: ", terminal, { write: (text: string) => written.push(text) > 0 });
    return { answer, written };
  }

  it("should read a line without echoing it and leave the raw mode", async () => {
    const terminal = new FakeTerminal();
    const { answer, written } = prompt(terminal);

    expect(terminal.rawMode).toBe(true);
    terminal.type("sec");
    terminal.type("ret\r");

    await expect(answer).resolves.toBe("secret");
    expect(terminal.rawMode).toBe(false);
    expect(written.join("")).toBe("Password: \n");
    expect(terminal.listenerCount("data")).toBe(0);
  });

  it("should remove the last character on backspace", async () => {
    const terminal = new FakeTerminal();
    const { answer } = prompt(terminal);

    terminal.type("secrex\u007ft\n");

    await expect(answer).resolves.toBe("secret");
  });

  it("should abort on Ctrl+C", async () => {
    const terminal = new FakeTerminal();
    const { answer } = prompt(terminal);

    terminal.type("sec\u0003");

    await expect(answer).rejects.toThrow("Aborted");
    expect(terminal.rawMode).toBe(false);
  });

  it("should read the first line of piped input", async () => {
    expect(await readFirstLine(Readable.from(["a-long-", "secret-1\r\nignored\n"]))).toBe("a-long-secret-1");
    expect(await readFirstLine(Readable.from(["no newline"]))).toBe("no newline");
  });
});
