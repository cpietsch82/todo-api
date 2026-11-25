// tests/setup/integration.setup.ts
import { beforeAll, afterAll, afterEach } from "vitest";
import { Express } from "express";
import type { Server } from "node:http";
import { ExpressAPI } from "../src/modules/express/Express";
import { listenOnLoopback } from "./supertest.loopback";
import { db } from "@/db";
import { todos, todoLists, users, authentications, deployments, containerStatus, containerLogRequests } from "@/db/schema";

let app: Express | null = null;
// the server the tests send their requests to, see listenOnLoopback
let testServer: Server | null = null;
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
  testServer = await listenOnLoopback(app);

  isInitialized = true;
  console.log("Integration Test setup complete\n")

  return app;
}

/**
 * The server to hand to supertest (request(getTestServer())), already listening on the IPv4 loopback.
 */
export function getTestServer(): Server {
  if (!testServer) {
    throw new Error("Test server not initialized. Did you call setupIntegrationTests()?");
  }
  return testServer;
}

/**
 * Return Express app (lazy). Send requests to getTestServer() instead, see listenOnLoopback.
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
  // deployments first: an operation left active by one test would block the next one (only one may be active)
  await db.delete(deployments);
  await db.delete(containerStatus);
  await db.delete(containerLogRequests);
  await db.delete(todos);
  // members and invitations go with their list
  await db.delete(todoLists);
  await db.delete(authentications);
  await db.delete(users);
}

export async function teardownIntegrationTests() {
  if (testServer) {
    const server = testServer;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    testServer = null;
  }
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
