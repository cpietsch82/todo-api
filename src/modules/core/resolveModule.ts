import { BaseModule } from "@modules/core/BaseModule";

type ModuleConstructor = new () => BaseModule;

const resolving: ModuleConstructor[] = [];

/**
 * Creates a module and reports a dependency cycle with its chain of names, because a cycle between constructors would otherwise end in a stack overflow or a half-built object.
 */
export function resolveModule<T extends BaseModule>(ModuleClass: new () => T): T {
  const start = resolving.indexOf(ModuleClass);
  if (start !== -1) {
    const chain = [...resolving.slice(start), ModuleClass].map((module) => module.name);
    throw new Error(`Dependency cycle: ${chain.join(" → ")}`);
  }

  resolving.push(ModuleClass);
  try {
    return new ModuleClass();
  } finally {
    resolving.pop();
  }
}
