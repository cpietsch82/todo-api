import { db } from "@/db";
import { eq, desc } from "drizzle-orm";
import { BaseModule } from "../core/BaseModule";
import { todos, type UpdateTodo, type NewTodo, type Todo } from "@/modules/todos/schema/todo.schema";
import { hasPermission, type Permission } from "@/modules/authorization/permissions";

/** the user who wants to access a todo, as the access token describes it (req.user) */
export interface AccessingUser {
  id: string;
  permissions?: readonly Permission[];
}

export class TodoService extends BaseModule {
  public static instance: TodoService;

  constructor() {
    super("todo.service", "Business logic for Todo management");

    if (!TodoService.instance) {
      TodoService.instance = this;
    }
    return TodoService.instance;
  }

  async getAllTodos(userId?: string): Promise<Todo[]> {
    const query = db.select().from(todos);

    if (userId) {
      return query.where(eq(todos.userId, userId)).orderBy(desc(todos.createdAt));
    }

    return query.orderBy(desc(todos.createdAt));
  }

  async getTodoById(todoId: string): Promise<Todo | undefined> {
    const [todo] = await db.select().from(todos).where(eq(todos.todoId, todoId)).limit(1);

    return todo;
  }

  /**
   * The one rule who may see a todo. Everything that depends on seeing a todo uses it: reading the todo and taking
   * part in its discussion (writing and, later, reading its comments). Changing or deleting a todo stays with its
   * creator (requireTodoOwnership).
   *
   * Today a todo is only visible to its creator and to admins. It is async on purpose: the extension for sharing
   * will need a database query.
   */
  async canAccessTodo(todo: Pick<Todo, "userId">, user: AccessingUser): Promise<boolean> {
    if (hasPermission(user.permissions, "admin:all")) return true;

    // TODO(sharing): also allow the users a todo or its list is shared with, as soon as todos/lists can be shared
    // (TODOS.txt "Todo Listen" / "Listen auch sharen"). Reading the todo and commenting on it follow automatically.
    return todo.userId === user.id;
  }

  async createTodo(data: NewTodo): Promise<Todo> {
    const [todo] = await db.insert(todos).values(data).returning();

    return todo;
  }

  async updateTodo(todoId: string, updateData: UpdateTodo): Promise<Todo> {
    const [todo] = await db
      .update(todos)
      .set({
        ...updateData,
        updatedAt: new Date(),
      })
      .where(eq(todos.todoId, todoId))
      .returning();

    return todo;
  }

  async deleteTodo(todoId: string): Promise<Todo> {
    const [todo] = await db.delete(todos).where(eq(todos.todoId, todoId)).returning();

    return todo;
  }
}

export default TodoService;
