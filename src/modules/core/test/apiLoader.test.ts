import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { APIModule } from "@modules/core/APIModule";
import { findAPIModuleFiles, instantiateAPIModules } from "@modules/core/apiLoader";
import { ExpressAPI } from "@modules/express/Express";
import { TodoListContactAPI } from "@modules/todo-lists/TodoListContactAPI";
import { TodoListService } from "@modules/todo-lists/TodoListService";
import { getTestServer } from "@tests/integration.setup";

// Source scan independent of the loader: every "class X extends APIModule" under src/modules, without test folders.
function scanSource(): { file: string; className: string }[] {
  const modulesDir = path.resolve(__dirname, "../..");
  const found: { file: string; className: string }[] = [];
  for (const entry of readdirSync(modulesDir, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".ts") || entry.split(path.sep).includes("test")) continue;
    const file = path.join(modulesDir, entry);
    for (const match of readFileSync(file, "utf8").matchAll(/class (\w+) extends APIModule\b/g)) {
      found.push({ file, className: match[1] });
    }
  }
  return found;
}

describe("apiLoader", () => {
  let server: Server;
  const declared = scanSource();

  beforeAll(() => {
    server = getTestServer();
  });

  it("should find the file of every class that extends APIModule", () => {
    expect(server).toBeDefined();
    expect(declared.length).toBeGreaterThanOrEqual(8);
    expect(findAPIModuleFiles()).toEqual(expect.arrayContaining(declared.map((d) => d.file)));
  });

  it("should create every API class and nothing else", async () => {
    const exports = await Promise.all(findAPIModuleFiles().map((file) => import(file)));
    const created = instantiateAPIModules(exports);
    expect(created.map((m) => m.constructor.name).sort()).toEqual(declared.map((d) => d.className).sort());
  });

  it("should create a class exported twice only once", () => {
    expect(instantiateAPIModules([{ TodoListContactAPI }, { TodoListContactAPI }])).toHaveLength(1);
  });

  it("should ignore exports that are no API classes", () => {
    expect(instantiateAPIModules([{ answer: 42, fn: () => 1, ExpressAPI, APIModule, TodoListService }])).toEqual([]);
  });

  it("should return sorted absolute paths without tests", () => {
    const files = findAPIModuleFiles();
    expect(files).toEqual([...files].sort());
    expect(files.every((f) => path.isAbsolute(f) && /API\.(ts|js)$/.test(f))).toBe(true);
  });

  it("should skip test folders, test files and everything not named *API", () => {
    // the build compiles helpers in test folders too, an *API file there must not reach production
    const root = mkdtempSync(path.join(tmpdir(), "api-loader-"));
    try {
      for (const file of ["todos/TodoAPI.ts", "todos/test/FakeAPI.ts", "todos/test/TodoAPI.test.ts", "core/APIModule.ts", "users/UserAPI.js"]) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), "");
      }

      expect(findAPIModuleFiles(root)).toEqual([path.join(root, "todos/TodoAPI.ts"), path.join(root, "users/UserAPI.js")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
