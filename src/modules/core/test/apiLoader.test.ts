import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { APIModule } from "@modules/core/APIModule";
import { findAPIModuleFiles, instantiateAPIModules } from "@modules/core/apiLoader";
import { ExpressAPI } from "@modules/express/Express";
import { TodoListContactAPI } from "@modules/todo-lists/TodoListContactAPI";
import { TodoListService } from "@modules/todo-lists/TodoListService";
import { getTestServer } from "@tests/integration.setup";

// Source scan independent of the loader: every "class X extends APIModule" under src/modules, without tests.
function scanSource(): { file: string; className: string }[] {
  const modulesDir = path.resolve(__dirname, "../..");
  const found: { file: string; className: string }[] = [];
  for (const entry of readdirSync(modulesDir, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    const file = path.join(modulesDir, entry);
    const match = /class (\w+) extends APIModule\b/.exec(readFileSync(file, "utf8"));
    if (match) found.push({ file, className: match[1] });
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
});
