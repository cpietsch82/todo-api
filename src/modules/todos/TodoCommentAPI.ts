import { validateBody, validateParams, validateQuery } from "@/middleware/validate";
import { APIModule } from "../core/APIModule";
import {
  type CommentPageQuery,
  commentPageQuerySchema,
  CreateTodoCommentBody,
  createTodoCommentSchema,
  type DeleteCommentQuery,
  deleteCommentQuerySchema,
  TodoCommentByIdParams,
  todoCommentByIdSchema,
  UpdateTodoCommentBody,
  updateTodoCommentSchema,
} from "./schema/todo.comment.schema";
import { typedHandler } from "@/utils/typedHandler";
import { TypedRequest, TypedRequestBody, TypedRequestParams } from "../express/Express";
import type { Request, Response } from "express";
import {
  CommentNotFoundError,
  InvalidMentionError,
  InvalidParentCommentError,
  TodoCommentService,
} from "./TodoCommentService";
import {
  requirePermissions,
  requireTodoAccess,
  requireTodoCommentDeleteAccess,
  requireTodoCommentEditAccess,
  requireTodoCommentOwnership,
  requireTodoCommentReadAccess,
} from "@/middleware/permissions";
import { resolveModule } from "@modules/core/resolveModule";

export class TodoCommentAPI extends APIModule {
  private static instance: TodoCommentAPI;
  private todoCommentService: TodoCommentService;

  constructor() {
    super("todoComment.api", "API Module for Todo Comment management", "/todo-comments");

    this.todoCommentService = resolveModule(TodoCommentService);

    if (!TodoCommentAPI.instance) {
      TodoCommentAPI.instance = this;
    }
    return TodoCommentAPI.instance;
  }

  protected initializeRoutes(): void {
    const requireCommentOwner = requireTodoCommentOwnership(resolveModule(TodoCommentService));
    // a comment can be written on every todo the user may see, not only on own ones: that makes a discussion
    const requireAccessToCommentedTodo = requireTodoAccess((req) => req.body?.commentRecord?.todoId);

    this.router.get("/", requirePermissions("todo-comments:read"), this.getAllTodoComments.bind(this));
    this.router.get(
      "/:commentId/replies",
      validateParams(todoCommentByIdSchema),
      requirePermissions("todo-comments:read"),
      requireTodoCommentReadAccess(),
      validateQuery(commentPageQuerySchema),
      typedHandler(this.getReplies.bind(this)),
    );
    this.router.get(
      "/:commentId",
      validateParams(todoCommentByIdSchema),
      requirePermissions("todo-comments:read"),
      requireCommentOwner,
      typedHandler(this.getTodoCommentById.bind(this)),
    );
    this.router.post(
      "/",
      requirePermissions("todo-comments:create"),
      // the validation first: the access check relies on todoId being a valid uuid
      validateBody(createTodoCommentSchema),
      requireAccessToCommentedTodo,
      typedHandler(this.createTodoComment.bind(this)),
    );
    this.router.patch(
      "/:commentId",
      validateParams(todoCommentByIdSchema),
      requirePermissions("todo-comments:update"),
      // the author, and only while the todo is still visible to the author (e.g. not after leaving the list)
      requireTodoCommentEditAccess(),
      validateBody(updateTodoCommentSchema),
      typedHandler(this.updateTodoComment.bind(this)),
    );
    this.router.delete(
      "/:commentId",
      validateParams(todoCommentByIdSchema),
      requirePermissions("todo-comments:delete"),
      // before the access check, which depends on the scope
      validateQuery(deleteCommentQuerySchema),
      // the author or the moderator of the discussion, a whole thread only the moderator
      requireTodoCommentDeleteAccess(),
      typedHandler(this.deleteTodoComment.bind(this)),
    );
  }

  private async getAllTodoComments(req: Request, res: Response) {
    const todoComments = await this.todoCommentService.getAllTodoCommentsForUser(req.user!.id);
    res.status(200).json(todoComments);
  }

  private async getTodoCommentById(req: TypedRequestParams<TodoCommentByIdParams>, res: Response) {
    const { commentId } = req.params;
    const todoComment = await this.todoCommentService.getTodoCommentById(commentId);
    if (!todoComment) return res.respondNotFound();
    res.status(200).json(todoComment);
  }

  private async getReplies(req: TypedRequestParams<TodoCommentByIdParams>, res: Response) {
    const page = await this.todoCommentService.getRepliesPage(req.params.commentId, res.locals.query as CommentPageQuery);
    res.status(200).json(page);
  }

  private async createTodoComment(req: TypedRequestBody<CreateTodoCommentBody>, res: Response) {
    const { commentRecord } = req.body;

    try {
      const todoComment = await this.todoCommentService.createTodoComment({
        ...commentRecord,
        userId: req.user!.id,
      });
      // deleted right after it was written
      if (!todoComment) return res.respondNotFound();
      res.status(201).json(todoComment);
    } catch (error) {
      if (error instanceof InvalidParentCommentError) return res.respondBadRequest("Invalid parent comment", true);
      if (error instanceof InvalidMentionError) return res.respondBadRequest("Invalid mention", true);
      throw error;
    }
  }

  private async updateTodoComment(req: TypedRequest<TodoCommentByIdParams, UpdateTodoCommentBody>, res: Response) {
    const { commentId } = req.params;
    const { updates } = req.body;

    const todoComment = await this.todoCommentService.getTodoCommentById(commentId);
    if (!todoComment) return res.respondNotFound();

    try {
      const updatedTodoComment = await this.todoCommentService.updateTodoComment(commentId, updates);
      // deleted (or turned into a placeholder) after the access check
      if (!updatedTodoComment) return res.respondNotFound();
      res.status(200).json(updatedTodoComment);
    } catch (error) {
      if (error instanceof InvalidMentionError) return res.respondBadRequest("Invalid mention", true);
      throw error;
    }
  }

  private async deleteTodoComment(req: TypedRequestParams<TodoCommentByIdParams>, res: Response) {
    const { commentId } = req.params;
    const { scope } = res.locals.query as DeleteCommentQuery;

    try {
      const removal =
        scope === "branch"
          ? await this.todoCommentService.removeBranch(commentId)
          : await this.todoCommentService.removeComment(commentId);
      res.status(200).json(removal);
    } catch (error) {
      // deleted by someone else after the access check
      if (error instanceof CommentNotFoundError) return res.respondNotFound();
      throw error;
    }
  }
}

export default TodoCommentAPI;
