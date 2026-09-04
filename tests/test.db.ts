import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../src/db/schema";

// In-memory PostgreSQL instance — used exclusively in tests.
// Production code connects via postgres-js (src/db/index.ts).
export const pglite = new PGlite();
export const db = drizzle(pglite, { schema });

// Stub so that any code importing { migrationClient } from "@/db" compiles.
// The real migrationClient (postgres-js) is only relevant for src/db/migrate.ts
// which is never executed during tests.
export const migrationClient = null as unknown as ReturnType<typeof import("postgres")>;

// No-op in tests — PGlite is always available, no real TCP connection to verify.
export async function waitForDatabase(): Promise<void> {}
