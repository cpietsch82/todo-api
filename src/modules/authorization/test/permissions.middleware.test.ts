import { describe, it, expect, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { requireAuthentication, requireListRole, requirePermissions, requireSelf } from "@/middleware/permissions";
import type { TodoListService } from "@modules/todo-lists/TodoListService";
import type { ListRole, TodoList } from "@modules/todo-lists/schema/todo-list.schema";
import type { Permission } from "@modules/authorization/permissions";

function createMocks(options: { authenticated?: boolean; permissions?: Permission[]; params?: Record<string, string> } = {}) {
  const { authenticated = true, permissions = [], params = {} } = options;

  const req = {
    authenticated,
    user: authenticated ? { id: "user-1", permissions } : undefined,
    params,
  } as unknown as Request;
  const res = {
    respondAuthorizationRequired: vi.fn(),
    respondAuthorizationInsufficient: vi.fn(),
    respondNotFound: vi.fn(),
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;

  return { req, res, next };
}

describe("permission middleware", () => {
  // ---------------------------------------------------------------------------
  // requireAuthentication
  // ---------------------------------------------------------------------------
  describe("requireAuthentication", () => {
    it("should call next for an authenticated user", () => {
      const { req, res, next } = createMocks();

      requireAuthentication()(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.respondAuthorizationRequired).not.toHaveBeenCalled();
    });

    it("should respond with 401 for an unauthenticated request", () => {
      const { req, res, next } = createMocks({ authenticated: false });

      requireAuthentication()(req, res, next);

      expect(res.respondAuthorizationRequired).toHaveBeenCalledOnce();
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // requirePermissions
  // ---------------------------------------------------------------------------
  describe("requirePermissions", () => {
    it("should call next when the user has the required permission", () => {
      const { req, res, next } = createMocks({ permissions: ["todos:read"] });

      requirePermissions("todos:read")(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it("should call next when the user has admin:all", () => {
      const { req, res, next } = createMocks({ permissions: ["admin:all"] });

      requirePermissions("users:delete")(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it("should respond with 403 when a permission is missing", () => {
      const { req, res, next } = createMocks({ permissions: ["todos:read"] });

      requirePermissions("todos:read", "todos:delete")(req, res, next);

      expect(res.respondAuthorizationInsufficient).toHaveBeenCalledWith(
        "Missing permissions: todos:read, todos:delete",
        true,
      );
      expect(next).not.toHaveBeenCalled();
    });

    it("should respond with 401 for an unauthenticated request", () => {
      const { req, res, next } = createMocks({ authenticated: false });

      requirePermissions("todos:read")(req, res, next);

      expect(res.respondAuthorizationRequired).toHaveBeenCalledOnce();
      expect(res.respondAuthorizationInsufficient).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // requireSelf
  // ---------------------------------------------------------------------------
  describe("requireSelf", () => {
    it("should call next when the user accesses their own resource", () => {
      const { req, res, next } = createMocks({ params: { userId: "user-1" } });

      requireSelf()(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it("should call next for an admin accessing another user", () => {
      const { req, res, next } = createMocks({ permissions: ["admin:all"], params: { userId: "other" } });

      requireSelf()(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it("should respond with 403 when accessing another user without admin rights", () => {
      const { req, res, next } = createMocks({ params: { userId: "other" } });

      requireSelf()(req, res, next);

      expect(res.respondAuthorizationInsufficient).toHaveBeenCalledOnce();
      expect(next).not.toHaveBeenCalled();
    });

    it("should support a custom parameter name", () => {
      const { req, res, next } = createMocks({ params: { ownerId: "user-1" } });

      requireSelf("ownerId")(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it("should respond with 401 for an unauthenticated request", () => {
      const { req, res, next } = createMocks({ authenticated: false, params: { userId: "user-1" } });

      requireSelf()(req, res, next);

      expect(res.respondAuthorizationRequired).toHaveBeenCalledOnce();
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // requireListRole
  // ---------------------------------------------------------------------------
  describe("requireListRole", () => {
    const LIST = { listId: "list-1", ownerId: "owner-1", name: "Einkauf" } as TodoList;

    /** a service that knows one list and answers with the given role */
    function fakeService(role: ListRole | undefined, list: TodoList | null = LIST) {
      return {
        getListById: vi.fn().mockResolvedValue(list ?? undefined),
        getListRole: vi.fn().mockResolvedValue(role),
      } as unknown as TodoListService;
    }

    it("should respond with 401 for an unauthenticated request", async () => {
      const { req, res, next } = createMocks({ authenticated: false, params: { listId: "list-1" } });

      await requireListRole("viewer", undefined, fakeService("owner"))(req, res, next);

      expect(res.respondAuthorizationRequired).toHaveBeenCalledOnce();
      expect(next).not.toHaveBeenCalled();
    });

    it("should respond with 404 when the list does not exist", async () => {
      const { req, res, next } = createMocks({ params: { listId: "list-1" } });

      await requireListRole("viewer", undefined, fakeService(undefined, null))(req, res, next);

      expect(res.respondNotFound).toHaveBeenCalledOnce();
      expect(next).not.toHaveBeenCalled();
    });

    it("should respond with 403 when the role is too low", async () => {
      const { req, res, next } = createMocks({ params: { listId: "list-1" } });

      await requireListRole("owner", undefined, fakeService("editor"))(req, res, next);

      expect(res.respondAuthorizationInsufficient).toHaveBeenCalledWith("List role owner required", true);
      expect(next).not.toHaveBeenCalled();
    });

    it("should respond with 403 for a user without a role in the list", async () => {
      const { req, res, next } = createMocks({ params: { listId: "list-1" } });

      await requireListRole("viewer", undefined, fakeService(undefined))(req, res, next);

      expect(res.respondAuthorizationInsufficient).toHaveBeenCalledOnce();
      expect(next).not.toHaveBeenCalled();
    });

    it("should pass the list and the role on to the handler", async () => {
      const { req, res, next } = createMocks({ params: { listId: "list-1" } });

      await requireListRole("viewer", undefined, fakeService("editor"))(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(req.todoList).toBe(LIST);
      expect(req.listRole).toBe("editor");
    });
  });
});
