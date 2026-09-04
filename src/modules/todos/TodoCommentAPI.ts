import { validateBody, validateParams } from "@/middleware/validate";
import { APIModule } from "../core/APIModule";
import {
  CreateTodoCommentBody,
  createTodoCommentSchema,
  TodoComment,
  TodoCommentByIdParams,
  todoCommentByIdSchema,
  UpdateTodoCommentBody,
  updateTodoCommentSchema,
} from "./schema/todo.comment.schema";
import { typedHandler } from "@/utils/typedHandler";
import { TypedRequest, TypedRequestBody, TypedRequestParams } from "../express/Express";
import type { Request, Response } from "express";
import { TodoCommentService } from "./TodoCommentService";
import { requirePermissions, requireTodoCommentOwnership } from "@/middleware/permissions";

export class TodoCommentAPI extends APIModule {
  private static instance: TodoCommentAPI;
  private service: TodoCommentService;

  constructor() {
    super("todoComment.api", "API Module for Todo Comment management", "/todo-comments");

    this.service = new TodoCommentService();

    if (!TodoCommentAPI.instance) {
      TodoCommentAPI.instance = this;
    }
    return TodoCommentAPI.instance;
  }

  protected initializeRoutes(): void {
    const requireCommentOwner = requireTodoCommentOwnership(new TodoCommentService());

    this.router.get("/", requirePermissions("todo-comments:read"), this.getAllTodoComments.bind(this));
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
      validateBody(createTodoCommentSchema),
      typedHandler(this.createTodoComment.bind(this)),
    );
    this.router.patch(
      "/:commentId",
      validateParams(todoCommentByIdSchema),
      requirePermissions("todo-comments:update"),
      requireCommentOwner,
      validateBody(updateTodoCommentSchema),
      typedHandler(this.updateTodoComment.bind(this)),
    );
    this.router.delete(
      "/:commentId",
      validateParams(todoCommentByIdSchema),
      requirePermissions("todo-comments:delete"),
      requireCommentOwner,
      typedHandler(this.deleteTodoComment.bind(this)),
    );
  }

  private async getAllTodoComments(req: Request, res: Response) {
    const todoComments = await this.service.getAllTodoCommentsForUser(req.user!.id);
    res.status(200).json(todoComments);
  }

  private async getTodoCommentById(req: TypedRequestParams<TodoCommentByIdParams>, res: Response) {
    const { commentId } = req.params;
    const todoComment = await this.service.getTodoCommentById(commentId);
    if (!todoComment) return res.respondNotFound();
    res.status(200).json(todoComment);
  }

  private async createTodoComment(req: TypedRequestBody<CreateTodoCommentBody>, res: Response) {
    const { commentRecord } = req.body;

    const newComment = {
      ...commentRecord,
      userId: req.user?.id,
    };

    const todoComment = await this.service.createTodoComment(newComment as TodoComment);
    res.status(201).json(todoComment);
  }

  private async updateTodoComment(req: TypedRequest<TodoCommentByIdParams, UpdateTodoCommentBody>, res: Response) {
    const { commentId } = req.params;
    const { updates } = req.body;

    const todoComment = await this.service.getTodoCommentById(commentId);
    if (!todoComment) return res.respondNotFound();

    const updatedTodoComment = await this.service.updateTodoComment(commentId, updates);
    res.status(200).json(updatedTodoComment);
  }

  private async deleteTodoComment(req: TypedRequestParams<TodoCommentByIdParams>, res: Response) {
    const { commentId } = req.params;
    const deletedTodoComment = await this.service.deleteTodoComment(commentId);
    res.status(200).json(deletedTodoComment);
  }
}

export default TodoCommentAPI;
