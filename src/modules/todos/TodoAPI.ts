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
import { TypedRequest, TypedRequestBody, TypedRequestParams } from "../express/Express";
import { typedHandler } from "@/utils/typedHandler";

export class TodoAPI extends APIModule {
  private static instance: TodoAPI;
  private service: TodoService;

  constructor() {
    super("todo.api", "API Module for Todo CRUD operations", "/todos");

    this.service = new TodoService();

    if (!TodoAPI.instance) {
      TodoAPI.instance = this;
    }
    return TodoAPI.instance;
  }

  protected initializeRoutes(): void {
    this.router.get("/", this.getAllTodos.bind(this));
    this.router.get("/:todoId", validateParams(todoByIdSchema), typedHandler(this.getTodoById.bind(this)));
    this.router.post("/", validateBody(createTodoSchema), typedHandler(this.createTodo.bind(this)));
    this.router.patch(
      "/:todoId",
      validateParams(todoByIdSchema),
      validateBody(updateTodoSchema),
      typedHandler(this.updateTodo.bind(this)),
    );
    this.router.delete("/:todoId", validateParams(todoByIdSchema), typedHandler(this.deleteTodo.bind(this)));
    // weitere API Endpoints
    // - getActiveTodos
    // - getCompletedTodos
    // => eventuell aber auch einfach eine query Route bauen mit der ich filter übergeben kann!
  }

  private async getAllTodos(_req: Request, res: Response) {
    const todos = await this.service.getAllTodos();
    res.json(todos);
  }

  /**
   * Get a todo record by id. If no record was found it returns with status 404.
   */
  private async getTodoById(req: TypedRequestParams<TodoByIdParams>, res: Response) {
    const { todoId } = req.params;

    const todo = await this.service.getTodoById(todoId);
    if (!todo) return res.respondNotFound();
    res.json(todo);
  }

  /**
   * Creates a todo record and set some default values. Also sets the id of the
   * requested user as the userId for the record.
   */
  private async createTodo(req: TypedRequestBody<CreateTodoBody>, res: Response) {
    const { todoRecord } = req.body;

    const newTodo = {
      ...todoRecord,
      userId: req.user?.id, // TODO: überlegen, ob hier dann eine RequestingEntity sinnvoll wäre!
    };

    const todo = await this.service.createTodo(newTodo as Todo);
    res.status(201).json(todo);
  }

  private async updateTodo(req: TypedRequest<TodoByIdParams, UpdateTodoBody>, res: Response) {
    const { todoId } = req.params;
    const { updates } = req.body;
    // TODO: überprüfen, ob ich das hier überhaupt brauche, wenn ich ein Update auf eine Id machen will, die nicht existiert!
    // Denn somit könnte ich mir dann einen DB Call sparen!
    const todo = await this.service.getTodoById(todoId);
    if (!todo) return res.respondNotFound();

    const updatedTodo = await this.service.updateTodo(todoId, updates);
    res.status(201).json(updatedTodo);
  }

  private async deleteTodo(req: TypedRequestParams<TodoByIdParams>, res: Response) {
    const { todoId } = req.params;

    const deletedTodo = await this.service.deleteTodo(todoId);
    res.json(deletedTodo);
  }
}

export default TodoAPI;
