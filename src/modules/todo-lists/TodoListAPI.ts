import type { Request, Response } from "express";
import { APIModule } from "@modules/core/APIModule";
import { validateBody, validateParams } from "@/middleware/validate";
import { requireListRole, requirePermissions } from "@/middleware/permissions";
import { typedHandler } from "@/utils/typedHandler";
import { HttpError } from "@/utils/HttpError";
import type { TypedRequestBody } from "../express/Express";
import { TodoListService } from "./TodoListService";
import { MAX_LISTS_PER_USER } from "./limits";
import {
  createTodoListSchema,
  todoListByIdSchema,
  updateTodoListSchema,
  type CreateTodoListBody,
  type UpdateTodoListBody,
} from "./schema/todo-list.schema";

/**
 * Lists of todos. Who may do what in a list follows from the role in it (requireListRole); the permissions of the
 * access token are only the coarse gate.
 */
export class TodoListAPI extends APIModule {
  private static instance: TodoListAPI;
  private todoListService: TodoListService;

  constructor() {
    super("todo-list.api", "API Module for todo lists", "/todo-lists");

    this.todoListService = new TodoListService();

    if (!TodoListAPI.instance) {
      TodoListAPI.instance = this;
    }
    return TodoListAPI.instance;
  }

  protected initializeRoutes(): void {
    const byId = validateParams(todoListByIdSchema);

    this.router.get("/", requirePermissions("todo-lists:read"), this.getLists.bind(this));
    this.router.post(
      "/",
      requirePermissions("todo-lists:create"),
      validateBody(createTodoListSchema),
      typedHandler(this.createList.bind(this)),
    );
    this.router.get("/:listId", byId, requirePermissions("todo-lists:read"), requireListRole("viewer"), this.getList.bind(this));
    this.router.patch(
      "/:listId",
      byId,
      requirePermissions("todo-lists:update"),
      requireListRole("owner"),
      validateBody(updateTodoListSchema),
      typedHandler(this.updateList.bind(this)),
    );
    this.router.delete(
      "/:listId",
      byId,
      requirePermissions("todo-lists:delete"),
      requireListRole("owner"),
      this.deleteList.bind(this),
    );
    this.router.get(
      "/:listId/todos",
      byId,
      requirePermissions("todos:read"),
      requireListRole("viewer"),
      this.getTodosOfList.bind(this),
    );
  }

  private async getLists(req: Request, res: Response) {
    res.json(await this.todoListService.getListsForUser(req.user!.id));
  }

  private async createList(req: TypedRequestBody<CreateTodoListBody>, res: Response) {
    const ownerId = req.user!.id;
    if ((await this.todoListService.countListsOwnedBy(ownerId)) >= MAX_LISTS_PER_USER) {
      throw HttpError.conflict("List limit reached");
    }

    const { name, description } = req.body.listRecord;
    const list = await this.todoListService.createList({ name, description, ownerId });
    res.status(201).json(list);
  }

  private async getList(req: Request, res: Response) {
    res.json(await this.todoListService.getListSummary(req.todoList!, req.listRole!));
  }

  private async updateList(req: TypedRequestBody<UpdateTodoListBody>, res: Response) {
    const { name, description } = req.body.updates;
    res.json(await this.todoListService.updateList(req.todoList!.listId, { name, description }));
  }

  private async deleteList(req: Request, res: Response) {
    res.json(await this.todoListService.deleteList(req.todoList!.listId));
  }

  private async getTodosOfList(req: Request, res: Response) {
    res.json(await this.todoListService.getTodosOfList(req.todoList!.listId));
  }
}

export default TodoListAPI;
