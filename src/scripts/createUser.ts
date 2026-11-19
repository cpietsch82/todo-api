/**
 * Command line script to create a user (e.g. the first admin) or to give a user additional roles.
 * In the container: docker compose --env-file deploy.env exec api node dist/src/scripts/createUser.js --help
 */
import { parseCreateUserArgs, provisionUser, readNewPassword, USAGE, UsageError } from "./userProvisioning";

async function main(): Promise<number> {
  const options = parseCreateUserArgs(process.argv.slice(2));
  if (options === "help") {
    console.log(USAGE);
    return 0;
  }

  const result = await provisionUser(options, readNewPassword);

  console.log(result.created ? `Created user ${result.email} (${result.userId})` : `User ${result.email} already exists (${result.userId})`);
  console.log(`Added roles: ${result.addedRoles.length > 0 ? result.addedRoles.join(", ") : "none, it already had them"}`);
  console.log(`Roles now:   ${result.roles.join(", ")}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof UsageError) {
      console.error(`Error: ${error.message}`);
      console.error("Run with --help for the usage.");
    } else {
      console.error(error);
    }
    process.exit(1);
  },
);
