import type { NextFunction, Request, RequestHandler, Response } from "express";
import { hasEveryPermission, hasPermission, type Permission } from "@/modules/authorization/permissions";
import { TodoCommentService } from "@/modules/todos/TodoCommentService";
import { TodoService } from "@/modules/todos/TodoService";
import UserService from "@/modules/users/UserService";

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
      return todo?.userId;
    },
    "You are not allowed to access this todo",
  );
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
