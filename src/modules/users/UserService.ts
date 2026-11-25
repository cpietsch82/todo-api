import { db } from "@/db";
import { AnyColumn, and, asc, eq, isNull, SQLWrapper } from "drizzle-orm";
import { BaseModule } from "../core/BaseModule";
import { users, type NewUser, type UpdateUser, type User } from "./schema/user.schema";
import { todos } from "@/modules/todos/schema/todo.schema";
import { todoLists } from "@/modules/todo-lists/schema/todo-list.schema";
import { TodoListService } from "@/modules/todo-lists/TodoListService";

export class UserService extends BaseModule {
  public static instance: UserService;

  constructor() {
    super("user.service", "Business logic for User management");

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
   * The order matters: deleting the own lists turns the own todos in them into todos without a list first.
   */
  async deleteUser(userId: string): Promise<User> {
    return db.transaction(async (tx) => {
      const ownLists = await tx.select({ listId: todoLists.listId }).from(todoLists).where(eq(todoLists.ownerId, userId));
      for (const { listId } of ownLists) await new TodoListService().deleteList(listId, tx);

      await tx.delete(todos).where(and(eq(todos.userId, userId), isNull(todos.listId)));
      const [user] = await tx.delete(users).where(eq(users.userId, userId)).returning();

      return user;
    });
  }
}

export default UserService;
