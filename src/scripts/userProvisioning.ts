import { parseArgs } from "node:util";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/modules/users/schema/user.schema";
import { authentications, registerSchema } from "@/modules/authentication/schema/authentication.schema";
import { roles, userRoles } from "@/modules/authorization/schema/authorization.schema";
import { hashPassword } from "@/utils/passwords";
import { isUniqueViolation } from "@/utils/dbErrors";

/** every user gets this role, like a user who registers through the api */
export const DEFAULT_ROLE = "user";

export const USAGE = `Creates a user or gives an existing user additional roles.

Usage:
  node dist/src/scripts/createUser.js --email <email> --username <name> [--role <role>]... [options]

Options:
  --email <email>        e-mail of the user (required)
  --username <name>      user name, required for a new user
  --first-name <name>    first name of a new user
  --last-name <name>     last name of a new user
  --role <role>          additional role, e.g. admin or deployer; can be repeated or comma separated
  -h, --help             show this help

The password is asked for interactively and not shown. Without a terminal (docker compose exec -T)
it is read from the first line of stdin. Every user gets the role "${DEFAULT_ROLE}".
When the e-mail already belongs to a user, only the roles are added, the password stays unchanged.

Examples:
  docker compose --env-file deploy.env exec api node dist/src/scripts/createUser.js \\
    --email admin@example.com --username admin --role admin --role deployer
  docker compose --env-file deploy.env exec api node dist/src/scripts/createUser.js \\
    --email someone@example.com --role deployer`;

/** a wrong input of the person running the script: shown without a stack trace */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface CreateUserOptions {
  email: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  /** all roles the user should have, always including the default role */
  roles: string[];
}

export interface ProvisionResult {
  created: boolean;
  userId: string;
  email: string;
  /** the roles this run added */
  addedRoles: string[];
  /** all roles the user has now */
  roles: string[];
}

/**
 * Reads the command line arguments (without node and the script).
 * @returns "help" when the help was asked for
 */
export function parseCreateUserArgs(argv: string[]): CreateUserOptions | "help" {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        email: { type: "string" },
        username: { type: "string" },
        "first-name": { type: "string" },
        "last-name": { type: "string" },
        role: { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  if (values.help) return "help";
  if (!values.email) throw new UsageError("--email is required");

  const extraRoles = (values.role ?? []).flatMap((role) => role.split(",")).map((role) => role.trim()).filter(Boolean);

  return {
    // the same normalization as the api (emailSchema), otherwise the lookup of an existing user misses it
    email: values.email.trim().toLowerCase(),
    username: values.username?.trim(),
    firstName: values["first-name"]?.trim(),
    lastName: values["last-name"]?.trim(),
    roles: [...new Set([DEFAULT_ROLE, ...extraRoles])],
  };
}

function describeIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((issue) => `${issue.path.map(String).join(".") || "input"}: ${issue.message}`).join("; ");
}

/**
 * Creates the user with its password and roles, or adds the roles to an existing user with the same e-mail.
 * Everything is checked before the password is asked for, and written in one transaction.
 * @param readPassword asks for the password, only called for a new user
 */
export async function provisionUser(
  options: CreateUserOptions,
  readPassword: () => Promise<string>,
): Promise<ProvisionResult> {
  const roleRows = await db
    .select({ roleId: roles.roleId, name: roles.name })
    .from(roles)
    .where(inArray(roles.name, options.roles));
  const unknownRoles = options.roles.filter((name) => !roleRows.some((role) => role.name === name));
  if (unknownRoles.length > 0) {
    const known = await db.select({ name: roles.name }).from(roles).orderBy(roles.name);
    throw new UsageError(
      `Unknown role(s): ${unknownRoles.join(", ")}. Known roles: ${known.map((role) => role.name).join(", ")}`,
    );
  }

  const [existing] = await db
    .select({ userId: users.userId })
    .from(users)
    .where(eq(users.email, options.email))
    .limit(1);

  let newUser: { username: string; firstName?: string | null; lastName?: string | null; password: string } | undefined;
  if (existing) {
    if (options.username || options.firstName || options.lastName) {
      throw new UsageError(
        `A user with the e-mail ${options.email} already exists, only --role can be given to add roles`,
      );
    }
  } else {
    if (!options.username) throw new UsageError("--username is required for a new user");

    // the same rules as the registration through the api
    const profile = registerSchema.omit({ password: true }).safeParse({
      email: options.email,
      username: options.username,
      firstName: options.firstName,
      lastName: options.lastName,
    });
    if (!profile.success) throw new UsageError(describeIssues(profile.error));

    const password = await readPassword();
    const checkedPassword = registerSchema.shape.password.safeParse(password);
    if (!checkedPassword.success) throw new UsageError(`password: ${checkedPassword.error.issues[0].message}`);

    // the normalized values (trimmed, unicode form, empty name as null), the same as a registration stores
    newUser = {
      username: profile.data.username,
      firstName: profile.data.firstName,
      lastName: profile.data.lastName,
      password: await hashPassword(checkedPassword.data),
    };
  }

  const { userId, addedRoles } = await db
    .transaction(async (tx) => {
      let userId = existing?.userId;
      if (newUser) {
        const [user] = await tx
          .insert(users)
          .values({
            email: options.email,
            username: newUser.username,
            firstName: newUser.firstName,
            lastName: newUser.lastName,
          })
          .returning({ userId: users.userId });
        userId = user.userId;
        await tx.insert(authentications).values({ userId, password: newUser.password });
      }

      const added = await tx
        .insert(userRoles)
        .values(roleRows.map((role) => ({ userId: userId!, roleId: role.roleId })))
        .onConflictDoNothing()
        .returning({ roleId: userRoles.roleId });

      return {
        userId: userId!,
        addedRoles: roleRows.filter((role) => added.some((row) => row.roleId === role.roleId)).map((role) => role.name),
      };
    })
    .catch((error: unknown) => {
      // another user has the username, or the e-mail was taken in the meantime
      if (isUniqueViolation(error)) throw new UsageError("Email or username already in use");
      throw error;
    });

  const allRoles = await db
    .select({ name: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.roleId))
    .where(eq(userRoles.userId, userId))
    .orderBy(roles.name);

  return {
    created: Boolean(newUser),
    userId,
    email: options.email,
    addedRoles,
    roles: allRoles.map((role) => role.name),
  };
}

// ---------------------------------------------------------------------------
// password input
// ---------------------------------------------------------------------------

/** the parts of a terminal stream the prompt uses, so the tests can pass a fake */
export interface HiddenInput {
  setRawMode(mode: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  off(event: "data", listener: (chunk: string) => void): unknown;
}

/**
 * Asks for a line in the terminal without showing what is typed.
 * Enter finishes, backspace removes the last character, Ctrl+C and Ctrl+D abort.
 */
export function promptHidden(
  prompt: string,
  input: HiddenInput = process.stdin,
  output: Pick<NodeJS.WritableStream, "write"> = process.stderr,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";

    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u0003" || char === "\u0004") return finish(new UsageError("Aborted"));
        if (char === "\u007f" || char === "\b") {
          value = [...value].slice(0, -1).join("");
          continue;
        }
        value += char;
      }
    };

    output.write(prompt);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.on("data", onData);
    input.resume();
  });
}

/** reads the first line of a stream, e.g. a password piped into the script */
export async function readFirstLine(input: AsyncIterable<string | Buffer>): Promise<string> {
  let data = "";
  for await (const chunk of input) {
    data += chunk.toString();
    if (data.includes("\n")) break;
  }
  return data.split(/\r?\n/)[0];
}

/**
 * The password of a new user: asked twice in a terminal, otherwise the first line of stdin.
 */
export async function readNewPassword(): Promise<string> {
  if (!process.stdin.isTTY) return readFirstLine(process.stdin);

  const password = await promptHidden("Password (min. 8 characters): ");
  const repeated = await promptHidden("Repeat the password: ");
  if (password !== repeated) throw new UsageError("The passwords do not match");
  return password;
}
