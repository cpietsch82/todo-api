import { db } from "@/db";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { BaseModule } from "../core/BaseModule";
import { todos, type UpdateTodo, type NewTodo, type Todo } from "@/modules/todos/schema/todo.schema";
import { hasPermission, type Permission } from "@/modules/authorization/permissions";
import { TodoListService } from "@/modules/todo-lists/TodoListService";
import { hasListRole } from "@/modules/todo-lists/listRoles";
import { todoListMembers, todoLists, type ListRole } from "@/modules/todo-lists/schema/todo-list.schema";

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

  /**
   * The todos a user created and can still reach: without a list, or in a list the user owns or is a member of.
   * Todos of others in shared lists are read with the list (TodoListService.getTodosOfList).
   */
  async getAllTodos(userId: string): Promise<Todo[]> {
    const ownLists = db.select({ listId: todoLists.listId }).from(todoLists).where(eq(todoLists.ownerId, userId));
    const memberLists = db
      .select({ listId: todoListMembers.listId })
      .from(todoListMembers)
      .where(eq(todoListMembers.userId, userId));

    return db
      .select()
      .from(todos)
      .where(
        and(
          eq(todos.userId, userId),
          or(isNull(todos.listId), inArray(todos.listId, ownLists), inArray(todos.listId, memberLists)),
        ),
      )
      .orderBy(desc(todos.createdAt));
  }

  async getTodoById(todoId: string): Promise<Todo | undefined> {
    const [todo] = await db.select().from(todos).where(eq(todos.todoId, todoId)).limit(1);

    return todo;
  }

  /**
   * The rules who may see, change and delete a todo. A todo in a list follows the role in that list only (its
   * creator has no extra rights there); a todo without list belongs to its creator. Admins may do everything.
   * Everything that depends on seeing a todo uses canAccessTodo: reading it and taking part in its discussion.
   */
  async canAccessTodo(todo: Pick<Todo, "userId" | "listId">, user: AccessingUser): Promise<boolean> {
    if (todo.listId) return (await this.getRoleInListOf(todo.listId, user)) !== undefined;
    return this.isCreatorOrAdmin(todo, user);
  }

  /** Changing a todo: in a list at least editor, otherwise its creator. */
  async canEditTodo(todo: Pick<Todo, "userId" | "listId">, user: AccessingUser): Promise<boolean> {
    if (todo.listId) return hasListRole(await this.getRoleInListOf(todo.listId, user), "editor");
    return this.isCreatorOrAdmin(todo, user);
  }

  /**
   * Deleting a todo, and taking it out of its list: in a list the owner, or an editor who created it; otherwise its
   * creator.
   */
  async canDeleteTodo(todo: Pick<Todo, "userId" | "listId">, user: AccessingUser): Promise<boolean> {
    if (!todo.listId) return this.isCreatorOrAdmin(todo, user);

    const role = await this.getRoleInListOf(todo.listId, user);
    return role === "owner" || (role === "editor" && todo.userId === user.id);
  }

  private isCreatorOrAdmin(todo: Pick<Todo, "userId">, user: AccessingUser): boolean {
    return hasPermission(user.permissions, "admin:all") || (todo.userId !== null && todo.userId === user.id);
  }

  private async getRoleInListOf(listId: string, user: AccessingUser): Promise<ListRole | undefined> {
    const todoListService = new TodoListService();
    const list = await todoListService.getListById(listId);
    return list ? todoListService.getListRole(list, user) : undefined;
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
