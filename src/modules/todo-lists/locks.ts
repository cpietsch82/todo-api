import { asc, eq, inArray } from "drizzle-orm";
import { users } from "@/modules/users/schema/user.schema";
import { HttpError } from "@/utils/HttpError";
import { todoLists, type TodoList } from "./schema/todo-list.schema";
import type { DbTransaction } from "./TodoListService";

// The lock order of every transaction that changes who may use a list (design 7.1):
//   1. user rows a new row will reference (FOR SHARE, ordered by user_id)
//   2. the list row (FOR UPDATE)
//   3. members, invitations and todos
// UserService.deleteUser locks the user row before the own lists. A transaction that inserts a row referencing a user
// (added_by, invited_by, user_id, a new owner_id) therefore has to lock that user row before the list, otherwise both
// wait for each other.

/**
 * Locks the rows of the given users against their deletion until the end of the transaction.
 * @returns the ids of the users that exist, ordered, without duplicates
 */
export async function lockUsers(tx: DbTransaction, userIds: string[]): Promise<string[]> {
  const ids = [...new Set(userIds)].sort();
  if (ids.length === 0) return [];

  const rows = await tx
    .select({ userId: users.userId })
    .from(users)
    .where(inArray(users.userId, ids))
    .orderBy(asc(users.userId))
    .for("share");
  return rows.map((row) => row.userId);
}

/**
 * Locks the row of a list for the rest of the transaction and checks it again under the lock.
 * @param expectedOwnerId the owner the role check of the request saw; another owner now means the list was handed
 *   over meanwhile, and the rights checked before do not hold anymore
 * @throws HttpError 404 when the list is gone, 409 when its owner changed
 */
export async function lockList(tx: DbTransaction, listId: string, expectedOwnerId?: string): Promise<TodoList> {
  const [list] = await tx.select().from(todoLists).where(eq(todoLists.listId, listId)).for("update");
  if (!list) throw HttpError.notFound("List not found");
  if (expectedOwnerId !== undefined && list.ownerId !== expectedOwnerId) {
    throw HttpError.conflict("The list changed meanwhile, please try again");
  }
  return list;
}
