import { describe, it, expect } from "vitest";
import { BaseModule } from "@modules/core/BaseModule";
import { resolveModule } from "@modules/core/resolveModule";
import { TodoListService } from "@modules/todo-lists/TodoListService";

class CycleA extends BaseModule {
  constructor() {
    super("cycle-a", "cycle a");
    resolveModule(CycleB);
  }
}

class CycleB extends BaseModule {
  constructor() {
    super("cycle-b", "cycle b");
    resolveModule(CycleC);
  }
}

class CycleC extends BaseModule {
  constructor() {
    super("cycle-c", "cycle c");
    resolveModule(CycleB);
  }
}

class Leaf extends BaseModule {
  constructor() {
    super("leaf", "leaf");
  }
}

class Parent extends BaseModule {
  leaf: Leaf;

  constructor() {
    super("parent", "parent");
    this.leaf = resolveModule(Leaf);
  }
}

class Broken extends BaseModule {
  constructor() {
    super("broken", "broken");
    throw new Error("boom");
  }
}

describe("resolveModule", () => {
  it("should name the chain of a cycle", () => {
    expect(() => resolveModule(CycleA)).toThrow("Dependency cycle: CycleB → CycleC → CycleB");
  });

  it("should give the same message again, the stack is empty after a cycle", () => {
    expect(() => resolveModule(CycleA)).toThrow("Dependency cycle: CycleB → CycleC → CycleB");
    expect(() => resolveModule(CycleA)).toThrow("Dependency cycle: CycleB → CycleC → CycleB");
  });

  it("should build a chain without a cycle", () => {
    const parent = resolveModule(Parent);
    expect(parent).toBeInstanceOf(Parent);
    expect(parent.leaf).toBeInstanceOf(Leaf);
  });

  it("should empty the stack after an error in a constructor", () => {
    expect(() => resolveModule(Broken)).toThrow("boom");
    expect(resolveModule(Leaf)).toBeInstanceOf(Leaf);
    expect(() => resolveModule(Broken)).toThrow("boom");
  });

  it("should keep the singletons of the services", () => {
    expect(resolveModule(TodoListService)).toBe(new TodoListService());
  });
});
