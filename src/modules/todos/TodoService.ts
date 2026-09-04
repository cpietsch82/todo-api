import { db } from "@/db";
import { eq, desc } from "drizzle-orm";
import { BaseModule } from "../core/BaseModule";
import { todos, type UpdateTodo, type NewTodo, type Todo } from "@/modules/todos/schema/todo.schema";

export class TodoService extends BaseModule {
  public static instance: TodoService;

  constructor() {
    super("todo.service", "Business logic for Todo management");

    if (!TodoService.instance) {
      TodoService.instance = this;
    }
    return TodoService.instance;
  }

  public async getAllTodos(userId?: string): Promise<Todo[]> {
    const query = db.select().from(todos);

    if (userId) {
      return query.where(eq(todos.userId, userId)).orderBy(desc(todos.createdAt));
    }

    return query.orderBy(desc(todos.createdAt));
  }

  public async getTodoById(todoId: string): Promise<Todo | undefined> {
    const [todo] = await db.select().from(todos).where(eq(todos.todoId, todoId)).limit(1);

    return todo;
  }

  public async createTodo(data: NewTodo): Promise<Todo> {
    const [todo] = await db.insert(todos).values(data).returning();

    return todo;
  }

  public async updateTodo(todoId: string, updateData: UpdateTodo): Promise<Todo> {
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

  public async deleteTodo(todoId: string): Promise<Todo> {
    const [todo] = await db.delete(todos).where(eq(todos.todoId, todoId));

    return todo;
  }
}

export default TodoService;
