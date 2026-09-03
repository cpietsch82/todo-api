import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import env from "../../env";

const connectionString = env.DATABASE_URL;

// Für Queries
const client = postgres(connectionString);
export const db = drizzle(client, { schema });

// Für Migrations
export const migrationClient = postgres(connectionString, { max: 1 });

/**
 * Verifies the database connection by running a lightweight probe query.
 * Retries up to `retries` times with `delayMs` milliseconds between attempts.
 * Throws an error if the database is not reachable after all retries.
 */
export async function waitForDatabase(retries = 5, delayMs = 2000): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await db.execute(sql`SELECT 1`);
      return;
    } catch (error: unknown) {
      if (attempt === retries) {
        throw new Error(
          `Database not reachable after ${retries} attempt(s). Last error: ${error instanceof Error ? error.message : String(error)}`, {cause: error},
        );
      }
      console.warn(`[DB] Connection attempt ${attempt}/${retries} failed — retrying in ${delayMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
