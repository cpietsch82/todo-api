import { db } from "@/db";
import { and, asc, count, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { BaseModule } from "@modules/core/BaseModule";
import { hasPermission } from "@/modules/authorization/permissions";
import { todos, type Todo } from "@/modules/todos/schema/todo.schema";
import type { AccessingUser } from "@/modules/todos/TodoService";
import { withRetryOnDeadlock } from "@/utils/dbErrors";
import { HttpError } from "@/utils/HttpError";
import { todoListMembers, todoLists, type ListRole, type TodoList } from "./schema/todo-list.schema";

/** a running transaction of the database */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** a list as the client gets it: with the role of the asking user and some numbers */
export type TodoListSummary = TodoList & {
  myRole: ListRole;
  todoCount: number;
  /** members without the owner */
  memberCount: number;
};

const todoCountOfList = sql<number>`(select count(*) from ${todos} where ${todos.listId} = ${todoLists.listId})`.mapWith(
  Number,
);
const memberCountOfList = sql<number>`(select count(*) from ${todoListMembers} where ${todoListMembers.listId} = ${todoLists.listId})`.mapWith(
  Number,
);

export class TodoListService extends BaseModule {
  public static instance: TodoListService;

  constructor() {
    super("todo-list.service", "Business logic for todo lists and the roles of their users");

    if (!TodoListService.instance) {
      TodoListService.instance = this;
    }
    return TodoListService.instance;
  }

  async getListById(listId: string): Promise<TodoList | undefined> {
    const [list] = await db.select().from(todoLists).where(eq(todoLists.listId, listId)).limit(1);
    return list;
  }

  /**
   * The one rule which role a user has in a list. Admins count as owner of every list.
   * @param tx read within this transaction, e.g. under the lock of the list
   * @returns undefined when the user has no role in the list
   */
  async getListRole(
    list: Pick<TodoList, "listId" | "ownerId">,
    user: AccessingUser,
    tx?: DbTransaction,
  ): Promise<ListRole | undefined> {
    if (list.ownerId === user.id || hasPermission(user.permissions, "admin:all")) return "owner";

    const [member] = await (tx ?? db)
      .select({ role: todoListMembers.role })
      .from(todoListMembers)
      .where(and(eq(todoListMembers.listId, list.listId), eq(todoListMembers.userId, user.id)))
      .limit(1);
    return member?.role;
  }

  /** Own lists and the lists the user is a member of, ordered by name. */
  async getListsForUser(userId: string): Promise<TodoListSummary[]> {
    const rows = await db
      .select({ list: todoLists, memberRole: todoListMembers.role, todoCount: todoCountOfList, memberCount: memberCountOfList })
      .from(todoLists)
      .leftJoin(todoListMembers, and(eq(todoListMembers.listId, todoLists.listId), eq(todoListMembers.userId, userId)))
      .where(or(eq(todoLists.ownerId, userId), isNotNull(todoListMembers.userId)))
      .orderBy(asc(todoLists.name), asc(todoLists.listId));

    return rows.map(({ list, memberRole, todoCount, memberCount }) => ({
      ...list,
      myRole: list.ownerId === userId ? "owner" : memberRole!,
      todoCount,
      memberCount,
    }));
  }

  /** @returns undefined when the list does not exist (anymore) */
  async getListSummary(list: TodoList, myRole: ListRole): Promise<TodoListSummary | undefined> {
    const [counts] = await db
      .select({ todoCount: todoCountOfList, memberCount: memberCountOfList })
      .from(todoLists)
      .where(eq(todoLists.listId, list.listId));
    if (!counts) return undefined;
    return { ...list, myRole, ...counts };
  }

  async countListsOwnedBy(userId: string): Promise<number> {
    const [{ value }] = await db.select({ value: count() }).from(todoLists).where(eq(todoLists.ownerId, userId));
    return value;
  }

  async countTodosInList(listId: string): Promise<number> {
    const [{ value }] = await db.select({ value: count() }).from(todos).where(eq(todos.listId, listId));
    return value;
  }

  async createList(data: { name: string; description?: string | null; ownerId: string }): Promise<TodoList> {
    const [list] = await db.insert(todoLists).values(data).returning();
    return list;
  }

  /**
   * @param expectedOwnerId the owner the role check of the request saw; checked again under the lock of the list
   * @returns undefined when the list does not exist (anymore)
   * @throws HttpError 409 when the list was handed over meanwhile
   */
  async updateList(
    listId: string,
    updates: { name?: string; description?: string | null },
    expectedOwnerId?: string,
  ): Promise<TodoList | undefined> {
    return withRetryOnDeadlock(() =>
      db.transaction(async (tx) => {
        if (!(await this.lockListOfOwner(tx, listId, expectedOwnerId))) return undefined;

        const [list] = await tx
          .update(todoLists)
          .set({ ...updates, updatedAt: new Date() })
          .where(eq(todoLists.listId, listId))
          .returning();
        return list;
      }),
    );
  }

  /**
   * Locks the row of a list; unlike lockList a missing list is no error here.
   * @returns false when the list does not exist
   * @throws HttpError 409 when the list has another owner than expected
   */
  private async lockListOfOwner(tx: DbTransaction, listId: string, expectedOwnerId?: string): Promise<boolean> {
    const [locked] = await tx
      .select({ ownerId: todoLists.ownerId })
      .from(todoLists)
      .where(eq(todoLists.listId, listId))
      .for("update");
    if (!locked) return false;
    if (expectedOwnerId !== undefined && locked.ownerId !== expectedOwnerId) {
      throw HttpError.conflict("The list changed meanwhile, please try again");
    }
    return true;
  }

  /**
   * Deletes a list. Its todos go back to their creators (todos.list_id SET NULL), todos whose creator was deleted
   * would then belong to nobody and are deleted. Members and invitations go with the list.
   * @param tx the running transaction (e.g. the deletion of the owner), otherwise an own one is used
   * @param expectedOwnerId the owner the role check of the request saw; checked again under the lock of the list
   * @returns undefined when the list does not exist
   * @throws HttpError 409 when the list was handed over meanwhile
   */
  async deleteList(listId: string, tx?: DbTransaction, expectedOwnerId?: string): Promise<TodoList | undefined> {
    // an own transaction is retried after a deadlock; a given one belongs to the caller, who decides on retrying
    if (!tx) {
      return withRetryOnDeadlock(() => db.transaction((ownTx) => this.deleteList(listId, ownTx, expectedOwnerId)));
    }

    // lock order of the spec (7.1): the list row first, then its todos ordered by id. A todo moved or added into the
    // list waits for the list row (its foreign key check) and fails cleanly once the list is gone; a concurrent
    // deletion of a creator waits for this transaction, or this one for it, and the statements below see its result
    // (READ COMMITTED reads again per statement)
    if (!(await this.lockListOfOwner(tx, listId, expectedOwnerId))) return undefined;
    await tx.select({ todoId: todos.todoId }).from(todos).where(eq(todos.listId, listId)).orderBy(asc(todos.todoId)).for("update");

    await tx.delete(todos).where(and(eq(todos.listId, listId), isNull(todos.userId)));
    const [list] = await tx.delete(todoLists).where(eq(todoLists.listId, listId)).returning();
    return list;
  }

  /** The todos of a list, oldest first. */
  async getTodosOfList(listId: string): Promise<Todo[]> {
    return db.select().from(todos).where(eq(todos.listId, listId)).orderBy(asc(todos.createdAt), asc(todos.todoId));
  }
}

export default TodoListService;
