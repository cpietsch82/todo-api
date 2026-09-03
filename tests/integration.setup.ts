// tests/setup/integration.setup.ts
import { beforeAll, afterAll, afterEach } from "vitest";
import { Express } from "express";
import { ExpressAPI } from "../src/modules/express/Express";
import { db } from "@/db";
import { todos, users, authentications } from "@/db/schema";

let app: Express | null = null;
let isInitialized = false;

/**
docker run --name repo alpine/git clone https://github.com/docker/getting-started.gitr Integration Tests (Express + Services)
 */
export async function setupIntegrationTests(): Promise<Express> {
  if (isInitialized && app) {
    return app;
  }

  console.log("Express + Services initialisieren")
  const api = new ExpressAPI();
  api.listen();
  app = api.getApp();

  isInitialized = true;
  console.log("Integration Test setup complete\n")

  return app;
}

/**
 * Return Express app (lazy)
 */
export function getTestApp(): Express {
  if (!app) {
    throw new Error("Test app not initialized. Did you call setupIntegrationTests()?");
  }
  return app;
}

/**
 * Truncates all tables to provide a clean state between tests.
 * Order respects foreign key constraints (children before parents).
 * Note: todo_comments are removed implicitly via ON DELETE CASCADE when todos/users
 * are deleted, so they do not need to be listed here explicitly.
 */
export async function cleanupDatabase() {
  await db.delete(todos);
  await db.delete(authentications);
  await db.delete(users);
}

export async function teardownIntegrationTests() {
  if (app) {
    const api = new ExpressAPI();
    await api.close();
  }
}

// Auto-Setup if imported
beforeAll(async () => {
  await setupIntegrationTests();
});

afterEach(async () => {
  await cleanupDatabase();
});

afterAll(async () => {
  await teardownIntegrationTests()
});
