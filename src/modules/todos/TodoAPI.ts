import type { Request, Response } from "express";
import { APIModule } from "@modules/core/APIModule";
import { TodoService } from "./TodoService";
import { TodoCommentService } from "./TodoCommentService";
import {
  CreateTodoBody,
  createTodoSchema,
  Todo,
  TodoByIdParams,
  todoByIdSchema,
  UpdateTodoBody,
  updateTodoSchema,
} from "./schema/todo.schema";
import { type CommentPageQuery, commentPageQuerySchema } from "./schema/todo.comment.schema";
import { validateBody, validateParams, validateQuery } from "@/middleware/validate";
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
import { resolveModule } from "@modules/core/resolveModule";
import { CommentEventsService, type CommentStream } from "./CommentEventsService";

export class TodoAPI extends APIModule {
  private static instance: TodoAPI;
  private todoService: TodoService;
  private todoCommentService: TodoCommentService;

  constructor() {
    super("todo.api", "API Module for Todo CRUD operations", "/todos");

    this.todoService = resolveModule(TodoService);
    this.todoCommentService = resolveModule(TodoCommentService);

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
    // the discussion of a todo: every user who may see the todo reads all its comments
    this.router.get(
      "/:todoId/comments",
      validateParams(todoByIdSchema),
      validateQuery(commentPageQuerySchema),
      requirePermissions("todo-comments:read"),
      requireAccess,
      typedHandler(this.getCommentsOfTodo.bind(this)),
    );
    // live changes of that discussion as server-sent events
    this.router.get(
      "/:todoId/comments/events",
      validateParams(todoByIdSchema),
      requirePermissions("todo-comments:read"),
      requireAccess,
      this.streamCommentEvents.bind(this),
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
    // loaded by requireTodoAccess, which answers 404 for an unknown todo
    res.json(req.todo!);
  }

  private async getCommentsOfTodo(req: TypedRequestParams<TodoByIdParams>, res: Response) {
    res.json(await this.todoCommentService.getDiscussionPage(req.params.todoId, res.locals.query as CommentPageQuery));
  }

  private streamCommentEvents(req: Request, res: Response) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(": connected\n\n");

    const stream: CommentStream = {
      user: req.user!,
      expiresAt: req.user!.exp! * 1000,
      send: (event, data) => {
        if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      },
      ping: () => {
        if (!res.writableEnded) res.write(": ping\n\n");
      },
      close: () => {
        if (!res.writableEnded) res.end();
      },
    };
    const unsubscribe = resolveModule(CommentEventsService).subscribe(req.params.todoId as string, stream);
    // the response closes with the connection, the request already closes once its body is read
    res.on("close", unsubscribe);
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

    // the list rights are checked once more under the lock of the list
    const todo = await this.todoService.createTodo(newTodo as Todo, req.user!);
    res.status(201).json(todo);
  }

  private async updateTodo(req: TypedRequest<TodoByIdParams, UpdateTodoBody>, res: Response) {
    const { todoId } = req.params;
    const { updates } = req.body;
    // loaded by requireTodoEditAccess, which answers 404 for an unknown todo
    const todo = req.todo!;

    if (updates.listId !== undefined && updates.listId !== todo.listId) {
      await this.ensureCanMove(todo, updates.listId, req.user!);
    }

    // a move is checked once more under the locks of both lists
    const updatedTodo = await this.todoService.updateTodo(todoId, updates, req.user!, todo.listId);
    // deleted after the access check
    if (!updatedTodo) return res.respondNotFound();
    res.status(201).json(updatedTodo);
  }

  /**
   * A todo may be put into a list by an editor or the owner of the list, as long as the list is not full.
   * @throws HttpError 404 for an unknown list, 403 below editor, 409 for a full list
   */
  private async ensureCanAddToList(listId: string, user: AccessingUser): Promise<void> {
    const todoListService = resolveModule(TodoListService);
    const list = await todoListService.getListById(listId);
    if (!list) throw HttpError.notFound("List not found");

    if (!hasListRole(await todoListService.getListRole(list, user), "editor")) {
      throw HttpError.forbidden("List role editor required to add a todo");
    }
    if ((await todoListService.countTodosInList(listId)) >= MAX_TODOS_PER_LIST) throw HttpError.conflict("List is full");
  }

  /**
   * Moving a todo needs the right to take it out of its current list (the same as deleting it there) and the right to
   * add it to the target list. Without a list it goes back to its creator.
   * @param targetListId null to take the todo out of its list
   */
  private async ensureCanMove(todo: Todo, targetListId: string | null, user: AccessingUser): Promise<void> {
    if (!(await this.todoService.canDeleteTodo(todo, user))) {
      throw HttpError.forbidden("Moving needs the right to take the todo out of its list");
    }

    // taking it out of its list needs nothing more; whether it still has a creator is checked under the lock of the
    // update (TodoService.updateTodo)
    if (targetListId === null) return;
    await this.ensureCanAddToList(targetListId, user);
  }

  private async deleteTodo(req: TypedRequestParams<TodoByIdParams>, res: Response) {
    const { todoId } = req.params;

    const deletedTodo = await this.todoService.deleteTodo(todoId);
    // deleted by someone else after the access check
    if (!deletedTodo) return res.respondNotFound();
    res.json(deletedTodo);
  }
}

export default TodoAPI;
