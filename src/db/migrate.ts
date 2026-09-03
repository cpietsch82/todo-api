import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, migrationClient } from "./index";
import { logger } from "@/utils/logger";

async function main() {
  logger.info("Running migrations...");

  await migrate(db, { migrationsFolder: "./drizzle" });

  logger.info("Migrations complete!");

  await migrationClient.end();
  process.exit(0);
}

main().catch((err) => {
  logger.error("Migration failed");
  logger.error(err);
  process.exit(1);
});
