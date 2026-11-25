import { db } from "@/db";
import { and, asc, count, eq } from "drizzle-orm";
import { BaseModule } from "@modules/core/BaseModule";
import { users } from "@/modules/users/schema/user.schema";
import { HttpError } from "@/utils/HttpError";
import { withRetryOnDeadlock } from "@/utils/dbErrors";
import { lockList, lockUsers } from "./locks";
import { MAX_LISTS_PER_USER } from "./limits";
import { todoListMembers, todoLists, type ListRole, type MemberRole, type TodoList } from "./schema/todo-list.schema";
import type { DbTransaction } from "./TodoListService";

/** a user of a list as the other users of the list see it: no e-mail, no names */
export interface ListMember {
  userId: string;
  username: string;
  role: ListRole;
}

/**
 * The members of a list and the changes of them. The owner is not a member (todo_lists.owner_id) and can neither
 * leave nor be removed; it has to hand the list over first.
 */
export class TodoListMemberService extends BaseModule {
  public static instance: TodoListMemberService;

  constructor() {
    super("todo-list-member.service", "Members of todo lists: roles, leaving, handing a list over");

    if (!TodoListMemberService.instance) {
      TodoListMemberService.instance = this;
    }
    return TodoListMemberService.instance;
  }

  /** The owner first, then the members by username. */
  async getMembers(list: TodoList): Promise<ListMember[]> {
    const [owner] = await db
      .select({ userId: users.userId, username: users.username })
      .from(users)
      .where(eq(users.userId, list.ownerId));
    const members = await db
      .select({ userId: users.userId, username: users.username, role: todoListMembers.role })
      .from(todoListMembers)
      .innerJoin(users, eq(users.userId, todoListMembers.userId))
      .where(eq(todoListMembers.listId, list.listId))
      .orderBy(asc(users.username), asc(users.userId));

    return [...(owner ? [{ ...owner, role: "owner" as const }] : []), ...members];
  }

  /**
   * @param expectedOwnerId the owner the role check of the request saw
   * @throws HttpError 404 for a list or member that does not exist, 409 for the owner as target or a changed owner
   */
  async changeRole(listId: string, userId: string, role: MemberRole, expectedOwnerId: string): Promise<ListMember> {
    return withRetryOnDeadlock(() =>
      db.transaction(async (tx) => {
        const list = await lockList(tx, listId, expectedOwnerId);
        if (list.ownerId === userId) throw HttpError.conflict("The owner has no member role");

        const [changed] = await tx
          .update(todoListMembers)
          .set({ role })
          .where(and(eq(todoListMembers.listId, listId), eq(todoListMembers.userId, userId)))
          .returning({ userId: todoListMembers.userId });
        if (!changed) throw HttpError.notFound("Member not found");

        return { ...(await this.getMemberIdentity(tx, userId)), role };
      }),
    );
  }

  /**
   * Removes a member, or lets a member leave.
   * @param expectedOwnerId when the owner removes someone else: the owner the role check of the request saw
   * @throws HttpError 404 for a list or member that does not exist, 409 for the owner as target or a changed owner
   */
  async removeMember(listId: string, userId: string, expectedOwnerId?: string): Promise<ListMember> {
    return withRetryOnDeadlock(() =>
      db.transaction(async (tx) => {
        const list = await lockList(tx, listId, expectedOwnerId);
        if (list.ownerId === userId) throw HttpError.conflict("The owner cannot leave the list, transfer it first");

        const [removed] = await tx
          .delete(todoListMembers)
          .where(and(eq(todoListMembers.listId, listId), eq(todoListMembers.userId, userId)))
          .returning({ role: todoListMembers.role });
        if (!removed) throw HttpError.notFound("Member not found");

        return { ...(await this.getMemberIdentity(tx, userId)), role: removed.role };
      }),
    );
  }

  /**
   * Hands a list over to one of its members (design 8). The old owner stays in the list as editor.
   * @param actorId who hands it over: the owner, or an admin
   * @param expectedOwnerId the owner the role check of the request saw
   * @throws HttpError 404 for a list that is gone, 409 when the target is no member, owns too many lists already, or
   *   the list was handed over meanwhile
   */
  async transferList(listId: string, newOwnerId: string, actorId: string, expectedOwnerId: string): Promise<TodoList> {
    return withRetryOnDeadlock(() =>
      db.transaction(async (tx) => {
        // the old owner becomes a member and the actor is noted as the one who added it: lock both users and the new
        // owner against their deletion before the list (lock order of locks.ts)
        await lockUsers(tx, [expectedOwnerId, newOwnerId, actorId]);
        await lockList(tx, listId, expectedOwnerId);

        const [target] = await tx
          .select({ userId: todoListMembers.userId })
          .from(todoListMembers)
          .where(and(eq(todoListMembers.listId, listId), eq(todoListMembers.userId, newOwnerId)))
          .for("update");
        if (!target) throw HttpError.conflict("The new owner must be a member of the list");

        const [{ value: ownedLists }] = await tx.select({ value: count() }).from(todoLists).where(eq(todoLists.ownerId, newOwnerId));
        if (ownedLists >= MAX_LISTS_PER_USER) throw HttpError.conflict("List limit reached");

        await tx.delete(todoListMembers).where(and(eq(todoListMembers.listId, listId), eq(todoListMembers.userId, newOwnerId)));
        const [list] = await tx
          .update(todoLists)
          .set({ ownerId: newOwnerId, updatedAt: new Date() })
          .where(eq(todoLists.listId, listId))
          .returning();
        await tx.insert(todoListMembers).values({ listId, userId: expectedOwnerId, role: "editor", addedBy: actorId });
        return list;
      }),
    );
  }

  private async getMemberIdentity(tx: DbTransaction, userId: string): Promise<{ userId: string; username: string }> {
    const [user] = await tx
      .select({ userId: users.userId, username: users.username })
      .from(users)
      .where(eq(users.userId, userId));
    return user;
  }
}

export default TodoListMemberService;
