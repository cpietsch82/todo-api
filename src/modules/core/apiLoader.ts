import path from "node:path";
import { readdirSync } from "node:fs";
import { APIModule } from "@modules/core/APIModule";
import { resolveModule } from "@modules/core/resolveModule";
import { logger } from "@/utils/logger";

type APIModuleClass = new () => APIModule;

/**
 * Finds all files named *API.ts (or *API.js once compiled) below the modules directory, as absolute, sorted paths.
 */
export function findAPIModuleFiles(): string[] {
  const modulesDir = path.join(__dirname, "..");
  return readdirSync(modulesDir, { recursive: true, encoding: "utf8" })
    .filter((entry) => /API\.(ts|js)$/.test(entry))
    .map((entry) => path.join(modulesDir, entry))
    .sort();
}

/**
 * Creates every exported API class exactly once, because creating a class registers its routes.
 */
export function instantiateAPIModules(moduleExports: Record<string, unknown>[]): APIModule[] {
  const classes = new Set<APIModuleClass>();
  for (const exported of moduleExports) {
    for (const value of Object.values(exported)) {
      if (typeof value === "function" && value.prototype instanceof APIModule) classes.add(value as APIModuleClass);
    }
  }

  return [...classes].map((ModuleClass) => {
    const module = resolveModule(ModuleClass);
    logger.info({ moduleId: module.getModuleId() }, "API module registered");
    return module;
  });
}
