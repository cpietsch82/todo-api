import type { Request, Response } from "express";
import { APIModule } from "@modules/core/APIModule";
import { TodoService } from "./TodoService";
import {
  CreateTodoBody,
  createTodoSchema,
  Todo,
  TodoByIdParams,
  todoByIdSchema,
  UpdateTodoBody,
  updateTodoSchema,
} from "./schema/todo.schema";
import { validateBody, validateParams } from "@/middleware/validate";
import {
  requirePermissions,
  requireTodoAccess,
  requireTodoDeleteAccess,
  requireTodoEditAccess,
} from "@/middleware/permissions";
import { TypedRequest, TypedRequestBody, TypedRequestParams } from "../express/Express";
import { typedHandler } from "@/utils/typedHandler";
import { HttpError } from "@/utils/HttpError";
import { TodoListService } from "@/modules/todo-lists/TodoListService";
import { hasListRole } from "@/modules/todo-lists/listRoles";
import { MAX_TODOS_PER_LIST } from "@/modules/todo-lists/limits";
import type { AccessingUser } from "./TodoService";

export class TodoAPI extends APIModule {
  private static instance: TodoAPI;
  private todoService: TodoService;

  constructor() {
    super("todo.api", "API Module for Todo CRUD operations", "/todos");

    this.todoService = new TodoService();

    if (!TodoAPI.instance) {
      TodoAPI.instance = this;
    }
    return TodoAPI.instance;
  }

  protected initializeRoutes(): void {
    // who may read, change and delete a todo follows from TodoService (the list of the todo, or its creator)
    const requireAccess = requireTodoAccess();

    this.router.get("/", requirePermissions("todos:read"), this.getAllTodos.bind(this));
    this.router.get(
      "/:todoId",
      validateParams(todoByIdSchema),
      requirePermissions("todos:read"),
      requireAccess,
      typedHandler(this.getTodoById.bind(this)),
    );
    this.router.post("/", requirePermissions("todos:create"), validateBody(createTodoSchema), typedHandler(this.createTodo.bind(this)));
    this.router.patch(
      "/:todoId",
      validateParams(todoByIdSchema),
      requirePermissions("todos:update"),
      requireTodoEditAccess(),
      validateBody(updateTodoSchema),
      typedHandler(this.updateTodo.bind(this)),
    );
    this.router.delete(
      "/:todoId",
      validateParams(todoByIdSchema),
      requirePermissions("todos:delete"),
      requireTodoDeleteAccess(),
      typedHandler(this.deleteTodo.bind(this)),
    );
    // weitere API Endpoints
    // - getActiveTodos
    // - getCompletedTodos
    // => eventuell aber auch einfach eine query Route bauen mit der ich filter übergeben kann!
  }

  private async getAllTodos(req: Request, res: Response) {
    const todos = await this.todoService.getAllTodos(req.user!.id);
    res.json(todos);
  }

  /**
   * Get a todo record by id. If no record was found it returns with status 404.
   */
  private async getTodoById(req: TypedRequestParams<TodoByIdParams>, res: Response) {
    const { todoId } = req.params;

    const todo = await this.todoService.getTodoById(todoId);
    if (!todo) return res.respondNotFound();
    res.json(todo);
  }

  /**
   * Creates a todo record and set some default values. Also sets the id of the
   * requested user as the userId for the record.
   */
  private async createTodo(req: TypedRequestBody<CreateTodoBody>, res: Response) {
    const { todoRecord } = req.body;
    if (todoRecord.listId) await this.ensureCanAddToList(todoRecord.listId, req.user!);

    const newTodo = {
      ...todoRecord,
      userId: req.user?.id, // TODO: überlegen, ob hier dann eine RequestingEntity sinnvoll wäre!
    };

    const todo = await this.todoService.createTodo(newTodo as Todo);
    res.status(201).json(todo);
  }

  private async updateTodo(req: TypedRequest<TodoByIdParams, UpdateTodoBody>, res: Response) {
    const { todoId } = req.params;
    const { updates } = req.body;
    // TODO: überprüfen, ob ich das hier überhaupt brauche, wenn ich ein Update auf eine Id machen will, die nicht existiert!
    // Denn somit könnte ich mir dann einen DB Call sparen!
    const todo = await this.todoService.getTodoById(todoId);
    if (!todo) return res.respondNotFound();

    if (updates.listId !== undefined && updates.listId !== todo.listId) {
      await this.ensureCanMove(todo, updates.listId, req.user!);
    }

    const updatedTodo = await this.todoService.updateTodo(todoId, updates);
    res.status(201).json(updatedTodo);
  }

  /**
   * A todo may be put into a list by an editor or the owner of the list, as long as the list is not full.
   * @throws HttpError 404 for an unknown list, 403 below editor, 409 for a full list
   */
  private async ensureCanAddToList(listId: string, user: AccessingUser): Promise<void> {
    const todoListService = new TodoListService();
    const list = await todoListService.getListById(listId);
    if (!list) throw HttpError.notFound("List not found");

    if (!hasListRole(await todoListService.getListRole(list, user), "editor")) throw HttpError.forbidden();
    if ((await todoListService.countTodosInList(listId)) >= MAX_TODOS_PER_LIST) throw HttpError.conflict("List is full");
  }

  /**
   * Moving a todo needs the right to take it out of its current list (the same as deleting it there) and the right to
   * add it to the target list. Without a list it goes back to its creator, a todo whose creator was deleted would then
   * belong to nobody and stays.
   * @param targetListId null to take the todo out of its list
   */
  private async ensureCanMove(todo: Todo, targetListId: string | null, user: AccessingUser): Promise<void> {
    if (!(await this.todoService.canDeleteTodo(todo, user))) throw HttpError.forbidden();

    if (targetListId === null) {
      if (todo.userId === null) throw HttpError.conflict("A todo of a deleted user cannot leave its list");
      return;
    }
    await this.ensureCanAddToList(targetListId, user);
  }

  private async deleteTodo(req: TypedRequestParams<TodoByIdParams>, res: Response) {
    const { todoId } = req.params;

    const deletedTodo = await this.todoService.deleteTodo(todoId);
    res.json(deletedTodo);
  }
}

export default TodoAPI;
