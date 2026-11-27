import type { NextFunction, Request, RequestHandler, Response } from "express";
import { hasAnyPermission, hasEveryPermission, hasPermission, type Permission } from "@/modules/authorization/permissions";
import AuthorizationService from "@/modules/authorization/AuthorizationService";
import { TodoCommentService } from "@/modules/todos/TodoCommentService";
import { TodoService, type AccessingUser } from "@/modules/todos/TodoService";
import type { Todo } from "@/modules/todos/schema/todo.schema";
import type { DeleteCommentQuery, TodoComment } from "@/modules/todos/schema/todo.comment.schema";
import UserService from "@/modules/users/UserService";
import { TodoListService } from "@/modules/todo-lists/TodoListService";
import { hasListRole } from "@/modules/todo-lists/listRoles";
import type { ListRole, TodoList } from "@/modules/todo-lists/schema/todo-list.schema";
import { resolveModule } from "@modules/core/resolveModule";

declare global {
  namespace Express {
    interface Request {
      /** set by requireListRole: the list of the route */
      todoList?: TodoList;
      /** set by requireListRole: the role of the current user in that list */
      listRole?: ListRole;
      /** set by requireTodoAccess, requireTodoEditAccess and requireTodoDeleteAccess: the todo of the route */
      todo?: Todo;
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
    resolveModule(AuthorizationService),
  );
}

/**
 * Requires at least one of the permissions, read from the database on every request.
 */
export function requireAnyFreshPermission(...candidates: Permission[]): RequestHandler {
  return createFreshPermissionCheck(
    (granted) => hasAnyPermission(granted, candidates),
    "Insufficient Permissions!",
    resolveModule(AuthorizationService),
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

type TodoAccessCheck = (todoService: TodoService, todo: Todo, user: AccessingUser) => Promise<boolean>;

/**
 * Loads the todo of the request and checks the access with one of the rules of the TodoService.
 * 404 when the todo does not exist (also for admins), 403 when the rule does not allow the access.
 */
function createTodoAccessCheck(
  isAllowed: TodoAccessCheck,
  resolveTodoId: (req: Request) => string | undefined,
  todoService: TodoService,
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

    if (!(await isAllowed(todoService, todo, user))) {
      res.respondAuthorizationInsufficient("You are not allowed to access this todo", true);
      return;
    }

    // the handler uses it instead of loading the todo again
    req.todo = todo;
    next();
  };
}

const todoIdFromParams = (req: Request) => req.params.todoId as string | undefined;

/**
 * Requires access to a todo: the user may see it (TodoService.canAccessTodo), as creator of a todo without list or
 * with any role in the list of the todo. Guards everything that only needs to see the todo (reading it, taking part
 * in its discussion).
 * @param resolveTodoId where the todo id is, by default the route parameter todoId; must run after the validation
 */
export function requireTodoAccess(
  resolveTodoId: (req: Request) => string | undefined = todoIdFromParams,
  todoService: TodoService = resolveModule(TodoService),
): RequestHandler {
  return createTodoAccessCheck((service, todo, user) => service.canAccessTodo(todo, user), resolveTodoId, todoService);
}

/** Requires the right to change the todo of the route (TodoService.canEditTodo). */
export function requireTodoEditAccess(todoService: TodoService = resolveModule(TodoService)): RequestHandler {
  return createTodoAccessCheck((service, todo, user) => service.canEditTodo(todo, user), todoIdFromParams, todoService);
}

/** Requires the right to delete the todo of the route (TodoService.canDeleteTodo). */
export function requireTodoDeleteAccess(todoService: TodoService = resolveModule(TodoService)): RequestHandler {
  return createTodoAccessCheck((service, todo, user) => service.canDeleteTodo(todo, user), todoIdFromParams, todoService);
}

/**
 * Requires ownership of the referenced todo comment or admin privileges.
 */
export function requireTodoCommentOwnership(
  todoCommentService: TodoCommentService = resolveModule(TodoCommentService),
): RequestHandler {
  return createOwnershipMiddleware(
    async (req) => {
      const todoComment = await todoCommentService.getTodoCommentById(req.params.commentId as string);
      return todoComment?.userId ?? undefined;
    },
    "You are not allowed to access this todo comment",
  );
}

type TodoCommentCheck = (comment: TodoComment, todo: Todo, user: AccessingUser) => Promise<boolean>;

/**
 * Loads the comment of the route and its todo and checks the access with the given rule.
 * 404 when the comment (or its todo) does not exist, or the comment is deleted and options.allowDeleted is false, 403 with the reason in the log when the rule does not allow it.
 */
function createTodoCommentCheck(
  isAllowed: TodoCommentCheck,
  reason: string,
  todoCommentService: TodoCommentService,
  todoService: TodoService,
  options: { allowDeleted: boolean },
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = getAuthenticatedUser(req, res);
    if (!user) return;

    const comment = await todoCommentService.getTodoCommentById(req.params.commentId as string);
    const todo = comment ? await todoService.getTodoById(comment.todoId) : undefined;
    // a placeholder is no comment anymore: 404 before the rights are looked at
    if (!comment || !todo || (comment.deletedAt !== null && !options.allowDeleted)) {
      res.respondNotFound();
      return;
    }

    if (!(await isAllowed(comment, todo, user))) {
      res.respondAuthorizationInsufficient(reason, true);
      return;
    }

    next();
  };
}

/**
 * Requires the right to remove the comment of the route from its discussion. Reads the validated query, so it runs
 * after validateQuery(deleteCommentQuerySchema):
 * - scope=branch (the comment with all replies, also a placeholder): only moderators
 *   (TodoCommentService.canModerateComment)
 * - otherwise (placeholder rule): the author or a moderator (TodoCommentService.canDeleteComment); a placeholder is
 *   already deleted (404)
 */
export function requireTodoCommentDeleteAccess(
  todoCommentService: TodoCommentService = resolveModule(TodoCommentService),
  todoService: TodoService = resolveModule(TodoService),
): RequestHandler {
  const branchCheck = createTodoCommentCheck(
    (_comment, todo, user) => todoCommentService.canModerateComment(todo, user),
    "Only moderators may delete a whole thread",
    todoCommentService,
    todoService,
    { allowDeleted: true },
  );
  const commentCheck = createTodoCommentCheck(
    (comment, todo, user) => todoCommentService.canDeleteComment(comment, todo, user),
    "Not allowed to delete this comment",
    todoCommentService,
    todoService,
    { allowDeleted: false },
  );

  return (req: Request, res: Response, next: NextFunction) => {
    const { scope } = (res.locals.query ?? {}) as DeleteCommentQuery;
    return scope === "branch" ? branchCheck(req, res, next) : commentCheck(req, res, next);
  };
}

/**
 * Requires the right to change the comment of the route: its author (or an admin) who can still see the todo, so a
 * removed member cannot change what the list reads anymore.
 */
export function requireTodoCommentEditAccess(
  todoCommentService: TodoCommentService = resolveModule(TodoCommentService),
  todoService: TodoService = resolveModule(TodoService),
): RequestHandler {
  return createTodoCommentCheck(
    async (comment, todo, user) =>
      (hasPermission(user.permissions, "admin:all") || comment.userId === user.id) &&
      (await todoService.canAccessTodo(todo, user)),
    "Only the author with access to the todo may change a comment",
    todoCommentService,
    todoService,
    { allowDeleted: false },
  );
}

/** Requires the right to read the comment of the route: whoever may see its todo; placeholders are allowed. */
export function requireTodoCommentReadAccess(
  todoCommentService: TodoCommentService = resolveModule(TodoCommentService),
  todoService: TodoService = resolveModule(TodoService),
): RequestHandler {
  return createTodoCommentCheck(
    (_comment, todo, user) => todoService.canAccessTodo(todo, user),
    "Not allowed to read this comment",
    todoCommentService,
    todoService,
    { allowDeleted: true },
  );
}

/**
 * Requires ownership of the referenced user resource or admin privileges.
 */
export function requireUserOwnership(userService: UserService = resolveModule(UserService)): RequestHandler {
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
  todoListService: TodoListService = resolveModule(TodoListService),
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
