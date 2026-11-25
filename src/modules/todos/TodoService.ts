import { db } from "@/db";
import { and, asc, count, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { BaseModule } from "../core/BaseModule";
import { HttpError } from "@/utils/HttpError";
import { withRetryOnDeadlock } from "@/utils/dbErrors";
import { todos, type UpdateTodo, type NewTodo, type Todo } from "@/modules/todos/schema/todo.schema";
import { hasPermission, type Permission } from "@/modules/authorization/permissions";
import { TodoListService, type DbTransaction } from "@/modules/todo-lists/TodoListService";
import { lockList, lockUsers } from "@/modules/todo-lists/locks";
import { MAX_TODOS_PER_LIST } from "@/modules/todo-lists/limits";
import { hasListRole } from "@/modules/todo-lists/listRoles";
import { todoListMembers, todoLists, type ListRole, type TodoList } from "@/modules/todo-lists/schema/todo-list.schema";

/** the user who wants to access a todo, as the access token describes it (req.user) */
export interface AccessingUser {
  id: string;
  permissions?: readonly Permission[];
}

export class TodoService extends BaseModule {
  public static instance: TodoService;
  protected todoListService: TodoListService;

  constructor() {
    super("todo.service", "Business logic for Todo management");
    this.todoListService = new TodoListService();

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

  /**
   * Changing a todo: in a list at least editor, otherwise its creator.
   * @param tx read within this transaction, e.g. under the lock of the list
   */
  async canEditTodo(todo: Pick<Todo, "userId" | "listId">, user: AccessingUser, tx?: DbTransaction): Promise<boolean> {
    if (todo.listId) return hasListRole(await this.getRoleInListOf(todo.listId, user, tx), "editor");
    return this.isCreatorOrAdmin(todo, user);
  }

  /**
   * Deleting a todo, and taking it out of its list: in a list the owner, or an editor who created it; otherwise its
   * creator.
   * @param tx read within this transaction, e.g. under the lock of the list
   */
  async canDeleteTodo(todo: Pick<Todo, "userId" | "listId">, user: AccessingUser, tx?: DbTransaction): Promise<boolean> {
    if (!todo.listId) return this.isCreatorOrAdmin(todo, user);

    const role = await this.getRoleInListOf(todo.listId, user, tx);
    return role === "owner" || (role === "editor" && todo.userId === user.id);
  }

  private isCreatorOrAdmin(todo: Pick<Todo, "userId">, user: AccessingUser): boolean {
    return hasPermission(user.permissions, "admin:all") || (todo.userId !== null && todo.userId === user.id);
  }

  private async getRoleInListOf(listId: string, user: AccessingUser, tx?: DbTransaction): Promise<ListRole | undefined> {
    const list = tx
      ? (await tx.select().from(todoLists).where(eq(todoLists.listId, listId)))[0]
      : await this.todoListService.getListById(listId);
    return list ? this.todoListService.getListRole(list, user, tx) : undefined;
  }

  /**
   * Creates a todo. Into a list only as editor or owner and while the list is not full, both checked under the lock of
   * the list, so a role removed or a list filled meanwhile is respected (design 7.2).
   * @throws HttpError 404 unknown list, 403 below editor, 409 full list
   */
  async createTodo(data: NewTodo, user: AccessingUser): Promise<Todo> {
    const { listId } = data;
    if (!listId) {
      const [todo] = await db.insert(todos).values(data).returning();
      return todo;
    }

    return withRetryOnDeadlock(() =>
      db.transaction(async (tx) => {
        // the new todo references its creator: lock the user row before the list (lock order of locks.ts)
        await lockUsers(tx, [user.id]);
        const list = await lockList(tx, listId);
        await this.ensureCanAddUnderLock(tx, list, user);

        const [todo] = await tx.insert(todos).values(data).returning();
        return todo;
      }),
    );
  }

  /** @throws HttpError 403 below editor, 409 when the list is full */
  private async ensureCanAddUnderLock(tx: DbTransaction, list: TodoList, user: AccessingUser): Promise<void> {
    if (!hasListRole(await this.todoListService.getListRole(list, user, tx), "editor")) {
      throw HttpError.forbidden("List role editor required to add a todo");
    }
    const [{ value }] = await tx.select({ value: count() }).from(todos).where(eq(todos.listId, list.listId));
    if (value >= MAX_TODOS_PER_LIST) throw HttpError.conflict("List is full");
  }

  /**
   * Updates a todo under a lock of its row, so a concurrent deletion of its creator or its list cannot interleave:
   * a todo whose creator was deleted cannot leave its list (it would belong to nobody, chk_todos_owner_or_list).
   *
   * Moving it into another list (or out of its list) locks both lists first (lock order: lists by id, then the todo)
   * and checks the rights again under these locks: a role removed meanwhile must not still let it through (design 7.2).
   * @param user who changes the todo
   * @param expectedListId the list of the todo as the access check saw it
   * @returns undefined when the todo does not exist (anymore)
   * @throws HttpError 404 unknown target list, 403 missing rights, 409 todo moved meanwhile, full target, or a todo
   *   without creator that should leave its list
   */
  async updateTodo(
    todoId: string,
    updateData: UpdateTodo,
    user: AccessingUser,
    expectedListId: string | null,
  ): Promise<Todo | undefined> {
    const targetListId = updateData.listId;
    const moves = targetListId !== undefined && targetListId !== expectedListId;

    return withRetryOnDeadlock(() =>
      db.transaction(async (tx) => {
        const lockedLists = moves ? await this.lockListsOfMove(tx, expectedListId, targetListId) : new Map<string, TodoList>();

        const [current] = await tx
          .select({ userId: todos.userId, listId: todos.listId })
          .from(todos)
          .where(eq(todos.todoId, todoId))
          .for("update");
        if (!current) return undefined;

        if (moves) {
          if (current.listId !== expectedListId) throw HttpError.conflict("The list changed meanwhile, please try again");
          if (!(await this.canDeleteTodo(current, user, tx))) {
            throw HttpError.forbidden("Moving needs the right to take the todo out of its list");
          }
          if (targetListId) await this.ensureCanAddUnderLock(tx, lockedLists.get(targetListId)!, user);
        }

        if (updateData.listId === null && current.userId === null) {
          throw HttpError.conflict("A todo of a deleted user cannot leave its list");
        }

        const [todo] = await tx
          .update(todos)
          .set({ ...updateData, updatedAt: new Date() })
          .where(eq(todos.todoId, todoId))
          .returning();
        return todo;
      }),
    );
  }

  /**
   * Locks the source and the target list of a move, ordered by id. A source list deleted meanwhile is no error here:
   * the todo then lost its list, which the caller answers with 409.
   * @throws HttpError 404 when the target list does not exist
   */
  private async lockListsOfMove(
    tx: DbTransaction,
    sourceListId: string | null,
    targetListId: string | null | undefined,
  ): Promise<Map<string, TodoList>> {
    const ids = [...new Set([sourceListId, targetListId].filter((id): id is string => !!id))].sort();
    const rows = ids.length
      ? await tx.select().from(todoLists).where(inArray(todoLists.listId, ids)).orderBy(asc(todoLists.listId)).for("update")
      : [];
    const locked = new Map(rows.map((list) => [list.listId, list]));
    if (targetListId && !locked.has(targetListId)) throw HttpError.notFound("List not found");
    return locked;
  }

  /** @returns undefined when the todo does not exist (anymore) */
  async deleteTodo(todoId: string): Promise<Todo | undefined> {
    const [todo] = await db.delete(todos).where(eq(todos.todoId, todoId)).returning();

    return todo;
  }
}

export default TodoService;
