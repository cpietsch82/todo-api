import { db } from "@/db";
import { and, asc, eq } from "drizzle-orm";
import { BaseModule } from "@modules/core/BaseModule";
import { users } from "@/modules/users/schema/user.schema";
import { HttpError } from "@/utils/HttpError";
import { withRetryOnDeadlock } from "@/utils/dbErrors";
import { lockList } from "./locks";
import { todoListMembers, type ListRole, type MemberRole, type TodoList } from "./schema/todo-list.schema";
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

  private async getMemberIdentity(tx: DbTransaction, userId: string): Promise<{ userId: string; username: string }> {
    const [user] = await tx
      .select({ userId: users.userId, username: users.username })
      .from(users)
      .where(eq(users.userId, userId));
    return user;
  }
}

export default TodoListMemberService;
