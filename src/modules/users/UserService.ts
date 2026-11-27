import { db } from "@/db";
import { AnyColumn, and, asc, eq, isNull, SQLWrapper } from "drizzle-orm";
import { BaseModule } from "../core/BaseModule";
import { users, type NewUser, type UpdateUser, type User } from "./schema/user.schema";
import { todos } from "@/modules/todos/schema/todo.schema";
import { todoLists } from "@/modules/todo-lists/schema/todo-list.schema";
import { TodoListService } from "@/modules/todo-lists/TodoListService";
import { withRetryOnDeadlock } from "@/utils/dbErrors";
import { TodoCommentService } from "@/modules/todos/TodoCommentService";
import { resolveModule } from "@modules/core/resolveModule";

export class UserService extends BaseModule {
  public static instance: UserService;
  protected todoListService: TodoListService;
  protected todoCommentService: TodoCommentService;

  constructor() {
    super("user.service", "Business logic for User management");
    this.todoListService = resolveModule(TodoListService);
    this.todoCommentService = resolveModule(TodoCommentService);

    if (!UserService.instance) {
      UserService.instance = this;
    }
    return UserService.instance;
  }

  async createUser(data: NewUser): Promise<User> {
    const [user] = await db.insert(users).values(data).returning();

    return user;
  }

  async updateUser(userId: string, updateData: UpdateUser): Promise<User> {
    const [user] = await db.update(users).set(updateData).where(eq(users.userId, userId)).returning();

    return user;
  }

  async getAllUsers(sortBy: SQLWrapper | AnyColumn = users.createdAt): Promise<User[]> {
    const rows = await db.select().from(users).orderBy(asc(sortBy));

    return rows;
  }

  async getUserById(userId: string): Promise<User | undefined> {
    const user = await db.select().from(users).where(eq(users.userId, userId)).limit(1).then((rows) => rows[0]);

    return user;
  }

  /**
   * Deletes a user. Own lists are deleted (their todos go back to their creators), own todos without a list are
   * deleted. Todos of the user in lists of others stay there without creator (todos.user_id SET NULL).
   * Live comments of the user are removed by the placeholder rule: replies of others stay below a placeholder without
   * author, comments without replies are deleted.
   * The order matters: deleting the own lists turns the own todos in them into todos without a list first.
   * @returns undefined when the user does not exist (anymore), e.g. deleted by a concurrent request
   */
  async deleteUser(userId: string): Promise<User | undefined> {
    const { user, removals } = await withRetryOnDeadlock(() =>
      db.transaction(async (tx) => {
        // lock order of the spec (7.1): the user row, the own lists ordered by id, then the own todos ordered by id.
        // New todos and lists of the user wait for the user row (their foreign key check) and fail once the user is
        // gone; a concurrent deletion of a list waits for this transaction or this one for it, and the statements
        // below see its result
        await tx.select({ userId: users.userId }).from(users).where(eq(users.userId, userId)).for("update");
        const ownLists = await tx
          .select({ listId: todoLists.listId })
          .from(todoLists)
          .where(eq(todoLists.ownerId, userId))
          .orderBy(asc(todoLists.listId))
          .for("update");
        await tx.select({ todoId: todos.todoId }).from(todos).where(eq(todos.userId, userId)).orderBy(asc(todos.todoId)).for("update");

        for (const { listId } of ownLists) await this.todoListService.deleteList(listId, tx);

        await tx.delete(todos).where(and(eq(todos.userId, userId), isNull(todos.listId)));
        // comments are the last locked level: user, lists, todos, comments
        const removals = await this.todoCommentService.removeCommentsOfUser(userId, tx);
        const [user] = await tx.delete(users).where(eq(users.userId, userId)).returning();

        return { user, removals };
      }),
    );

    // after the commit: only now the discussions can see the placeholders
    if (user) for (const removal of removals) await this.todoCommentService.publishRemoval(removal);
    return user;
  }
}

export default UserService;
