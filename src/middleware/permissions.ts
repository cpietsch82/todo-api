import type { NextFunction, Request, RequestHandler, Response } from "express";
import { hasAnyPermission, hasEveryPermission, hasPermission, type Permission } from "@/modules/authorization/permissions";
import AuthorizationService from "@/modules/authorization/AuthorizationService";
import { TodoCommentService } from "@/modules/todos/TodoCommentService";
import { TodoService } from "@/modules/todos/TodoService";
import UserService from "@/modules/users/UserService";
import { TodoListService } from "@/modules/todo-lists/TodoListService";
import { hasListRole } from "@/modules/todo-lists/listRoles";
import type { ListRole, TodoList } from "@/modules/todo-lists/schema/todo-list.schema";

declare global {
  namespace Express {
    interface Request {
      /** set by requireListRole: the list of the route */
      todoList?: TodoList;
      /** set by requireListRole: the role of the current user in that list */
      listRole?: ListRole;
    }
  }
}

/**
 * Returns the currently authenticated user or sends a 401 response when no
 * authenticated user is available.
 */
function getAuthenticatedUser(req: Request, res: Response) {
  if (!req.authenticated || !req.user) {
    res.respondAuthorizationRequired();
    return;
  }

  return req.user;
}

/**
 * Requires a valid authenticated user on the request.
 */
export function requireAuthentication(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!getAuthenticatedUser(req, res)) return;
    next();
  };
}

/**
 * Requires the current user to have all listed permissions.
 */
export function requirePermissions(...required: Permission[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = getAuthenticatedUser(req, res);
    if (!user) return;

    if (!hasEveryPermission(user.permissions, required)) {
      res.respondAuthorizationInsufficient(`Missing permissions: ${required.join(", ")}`, true);
      return;
    }

    next();
  };
}

/**
 * Checks the permissions against the database instead of the claims of the access token, so a revoked role takes
 * effect with the next request and not only when the token expires. Costs one database round trip per request,
 * therefore it is used for the sensitive routes (admin area) only.
 */
function createFreshPermissionCheck(
  isAllowed: (granted: Permission[]) => boolean,
  describe: string,
  authorizationService: AuthorizationService,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = getAuthenticatedUser(req, res);
    if (!user) return;

    const stored = await authorizationService.getStoredAuthorization(user.id);
    // the user was deleted after the token was issued
    if (!stored) {
      res.respondAuthorizationRequired();
      return;
    }

    if (!isAllowed(stored.permissions)) {
      res.respondAuthorizationInsufficient(describe, true);
      return;
    }

    next();
  };
}

/**
 * Like requirePermissions, but the permissions are read from the database on every request.
 */
export function requireFreshPermissions(...required: Permission[]): RequestHandler {
  return createFreshPermissionCheck(
    (granted) => hasEveryPermission(granted, required),
    `Missing permissions: ${required.join(", ")}`,
    new AuthorizationService(),
  );
}

/**
 * Requires at least one of the permissions, read from the database on every request.
 */
export function requireAnyFreshPermission(...candidates: Permission[]): RequestHandler {
  return createFreshPermissionCheck(
    (granted) => hasAnyPermission(granted, candidates),
    "Insufficient Permissions!",
    new AuthorizationService(),
  );
}

/**
 * Requires the current user to access their own user resource unless they are
 * an admin.
 */
export function requireSelf(paramName = "userId"): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = getAuthenticatedUser(req, res);
    if (!user) return;

    if (hasPermission(user.permissions, "admin:all") || req.params[paramName] === user.id) {
      next();
      return;
    }

    res.respondAuthorizationInsufficient("You are not allowed to access this user", true);
  };
}

/**
 * Creates a reusable ownership middleware that allows admins to bypass the
 * owner check and otherwise compares the resolved owner id with the current
 * user id.
 */
function createOwnershipMiddleware(
  resolveOwnerId: (req: Request) => Promise<string | undefined>,
  message = "Insufficient Permissions!",
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = getAuthenticatedUser(req, res);
    if (!user) return;

    if (hasPermission(user.permissions, "admin:all")) {
      next();
      return;
    }

    const ownerId = await resolveOwnerId(req);
    if (!ownerId) {
      res.respondNotFound();
      return;
    }

    if (ownerId !== user.id) {
      res.respondAuthorizationInsufficient(message, true);
      return;
    }

    next();
  };
}

/**
 * Requires ownership of the referenced todo or admin privileges.
 */
export function requireTodoOwnership(todoService: TodoService = new TodoService()): RequestHandler {
  return createOwnershipMiddleware(
    async (req) => {
      const todo = await todoService.getTodoById(req.params.todoId as string);
      // a todo whose creator was deleted has no owner left (replaced by the list based check in the next step)
      return todo?.userId ?? undefined;
    },
    "You are not allowed to access this todo",
  );
}

/**
 * Requires access to a todo: the user may see it (TodoService.canAccessTodo). Unlike the ownership checks this is
 * not limited to the creator once todos can be shared, so it guards everything that only needs to see the todo
 * (reading it, taking part in its discussion).
 * 404 when the todo does not exist (also for admins), 403 when the user may not see it.
 * @param resolveTodoId where the todo id is, by default the route parameter todoId; must run after the validation
 */
export function requireTodoAccess(
  resolveTodoId: (req: Request) => string | undefined = (req) => req.params.todoId as string | undefined,
  todoService: TodoService = new TodoService(),
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = getAuthenticatedUser(req, res);
    if (!user) return;

    const todoId = resolveTodoId(req);
    const todo = todoId ? await todoService.getTodoById(todoId) : undefined;
    if (!todo) {
      res.respondNotFound();
      return;
    }

    if (!(await todoService.canAccessTodo(todo, user))) {
      res.respondAuthorizationInsufficient("You are not allowed to access this todo", true);
      return;
    }

    next();
  };
}

/**
 * Requires ownership of the referenced todo comment or admin privileges.
 */
export function requireTodoCommentOwnership(
  todoCommentService: TodoCommentService = new TodoCommentService(),
): RequestHandler {
  return createOwnershipMiddleware(
    async (req) => {
      const todoComment = await todoCommentService.getTodoCommentById(req.params.commentId as string);
      return todoComment?.userId;
    },
    "You are not allowed to access this todo comment",
  );
}

/**
 * Requires ownership of the referenced user resource or admin privileges.
 */
export function requireUserOwnership(userService: UserService = new UserService()): RequestHandler {
  return createOwnershipMiddleware(
    async (req) => {
      const user = await userService.getUserById(req.params.userId as string);
      return user?.userId;
    },
    "You are not allowed to access this user",
  );
}

/**
 * Requires at least the given role in the list of the route (owner > editor > viewer, admins count as owner). The
 * role is read from the database on every request, so a removed member loses the access with the next request.
 * 404 when the list does not exist, 403 when the role is too low. Passes the list and the role on as req.todoList and
 * req.listRole, so the handler does not need to load them again.
 * @param resolveListId where the list id is, by default the route parameter listId; must run after the validation
 */
export function requireListRole(
  minimum: ListRole,
  resolveListId: (req: Request) => string | undefined = (req) => req.params.listId as string | undefined,
  todoListService: TodoListService = new TodoListService(),
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = getAuthenticatedUser(req, res);
    if (!user) return;

    const listId = resolveListId(req);
    const list = listId ? await todoListService.getListById(listId) : undefined;
    if (!list) {
      res.respondNotFound();
      return;
    }

    const role = await todoListService.getListRole(list, user);
    if (!hasListRole(role, minimum)) {
      res.respondAuthorizationInsufficient(`List role ${minimum} required`, true);
      return;
    }

    req.todoList = list;
    req.listRole = role;
    next();
  };
}
