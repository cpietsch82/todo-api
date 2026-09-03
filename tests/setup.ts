import { beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/pglite/migrator";
import { db } from "./test.db";
import path from "path";

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.APP_STAGE = "test";

  // Apply all migrations to the isolated in-memory PGlite instance.
  // This creates the full production schema without touching any real database.
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "../drizzle") });
});

afterAll(async () => {
  // Cleanup after all tests
});
