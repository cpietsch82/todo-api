import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import request from "supertest";
import { findAPIModuleFiles, instantiateAPIModules } from "@modules/core/apiLoader";
import { getTestServer } from "@tests/integration.setup";
import { createAuthHeader, generateUser } from "@tests/test.helpers";

describe("apiLoader in the app", () => {
  it("should serve the routes of all APIs once the app has loaded them", async () => {
    const exports = await Promise.all(findAPIModuleFiles().map((file) => import(file)));
    instantiateAPIModules(exports);
    const user = await generateUser();

    for (const path of ["/api/todo-list-contacts", "/api/todo-list-invitations", "/api/todo-lists", "/api/todos"]) {
      expect((await request(getTestServer()).get(path).set(await createAuthHeader(user))).status).toBe(200);
    }
  });

  it("should start the app through the loader", () => {
    const index = readFileSync("src/index.ts", "utf8");
    expect(index).toContain("instantiateAPIModules(findAPIModuleFiles()");
    expect(index).not.toMatch(/new \w+API\(\)(?<!new ExpressAPI\(\))/);
  });
});
