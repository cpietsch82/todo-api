import { db } from "@/db";
import { and, asc, count, eq, gt, isNotNull, lte, sql } from "drizzle-orm";
import { BaseModule } from "@modules/core/BaseModule";
import { users } from "@/modules/users/schema/user.schema";
import { HttpError } from "@/utils/HttpError";
import { withRetryOnDeadlock } from "@/utils/dbErrors";
import { lockList, lockUsers } from "./locks";
import { INVITATION_LIFETIME_MS, MAX_MEMBERS_PER_LIST, MAX_OPEN_INVITATIONS_PER_LIST } from "./limits";
import {
  todoListInvitations,
  todoListMembers,
  todoLists,
  type MemberRole,
  type TodoList,
  type TodoListInvitation,
} from "./schema/todo-list.schema";

/** an open invitation as the owner of the list sees it: no e-mail, no names of the invited user */
export interface ListInvitation {
  invitationId: string;
  listId: string;
  invitee: { userId: string; username: string };
  role: MemberRole;
  createdAt: Date;
  expiresAt: Date;
}

/** an open invitation as the invited user sees it */
export interface ReceivedInvitation {
  invitationId: string;
  role: MemberRole;
  expiresAt: Date;
  list: { listId: string; name: string };
  invitedBy: { userId: string; username: string };
}

const isExpired = () => lte(todoListInvitations.expiresAt, new Date());
const isOpen = () => gt(todoListInvitations.expiresAt, new Date());

/**
 * Invitations to a list by username. The invited user has to accept, only then it becomes a member. Expired
 * invitations are filtered out and deleted when they are touched, no clean-up job is needed.
 */
export class TodoListInvitationService extends BaseModule {
  public static instance: TodoListInvitationService;

  constructor() {
    super("todo-list-invitation.service", "Invitations to todo lists");

    if (!TodoListInvitationService.instance) {
      TodoListInvitationService.instance = this;
    }
    return TodoListInvitationService.instance;
  }

  /**
   * Invites a user by username (normalized by the schema, the case is ignored).
   * @param actorId who invites: the owner, or an admin
   * @param expectedOwnerId the owner the role check of the request saw
   * @throws HttpError 404 unknown user or list, 400 for oneself, 409 member, already invited, limits, changed owner
   */
  async createInvitation(
    listId: string,
    username: string,
    role: MemberRole,
    actorId: string,
    expectedOwnerId: string,
  ): Promise<ListInvitation> {
    // lower() on both sides in SQL, so the database decides what is the same name, like its unique index does
    const [invitee] = await db
      .select({ userId: users.userId, username: users.username })
      .from(users)
      .where(sql`lower(${users.username}) = lower(${username})`)
      .limit(1);
    if (!invitee) throw HttpError.notFound("User not found");
    if (invitee.userId === actorId) throw HttpError.badRequest("You cannot invite yourself");

    return withRetryOnDeadlock(() =>
      db.transaction(async (tx) => {
        await lockUsers(tx, [actorId, invitee.userId]);
        const list = await lockList(tx, listId, expectedOwnerId);

        const [member] = await tx
          .select({ userId: todoListMembers.userId })
          .from(todoListMembers)
          .where(and(eq(todoListMembers.listId, listId), eq(todoListMembers.userId, invitee.userId)));
        if (member || list.ownerId === invitee.userId) throw HttpError.conflict("User is already a member of the list");

        const ofInvitee = and(eq(todoListInvitations.listId, listId), eq(todoListInvitations.inviteeId, invitee.userId));
        await tx.delete(todoListInvitations).where(and(ofInvitee, isExpired()));
        const [pending] = await tx.select({ id: todoListInvitations.invitationId }).from(todoListInvitations).where(ofInvitee);
        if (pending) throw HttpError.conflict("User is already invited");

        const [{ value: members }] = await tx
          .select({ value: count() })
          .from(todoListMembers)
          .where(eq(todoListMembers.listId, listId));
        if (members >= MAX_MEMBERS_PER_LIST) throw HttpError.conflict("List has reached the member limit");

        const [{ value: openInvitations }] = await tx
          .select({ value: count() })
          .from(todoListInvitations)
          .where(and(eq(todoListInvitations.listId, listId), isOpen()));
        if (openInvitations >= MAX_OPEN_INVITATIONS_PER_LIST) throw HttpError.conflict("List has reached the invitation limit");

        const [created] = await tx
          .insert(todoListInvitations)
          .values({
            listId,
            inviteeId: invitee.userId,
            role,
            invitedBy: actorId,
            expiresAt: new Date(Date.now() + INVITATION_LIFETIME_MS),
          })
          .returning();
        return {
          invitationId: created.invitationId,
          listId: created.listId,
          invitee,
          role: created.role,
          createdAt: created.createdAt,
          expiresAt: created.expiresAt,
        };
      }),
    );
  }

  /** The open invitations of a list, oldest first. Deletes the expired ones of the list. */
  async getOpenInvitationsOfList(listId: string): Promise<ListInvitation[]> {
    await db.delete(todoListInvitations).where(and(eq(todoListInvitations.listId, listId), isExpired()));

    const rows = await db
      .select({
        invitationId: todoListInvitations.invitationId,
        listId: todoListInvitations.listId,
        role: todoListInvitations.role,
        createdAt: todoListInvitations.createdAt,
        expiresAt: todoListInvitations.expiresAt,
        inviteeId: users.userId,
        inviteeUsername: users.username,
      })
      .from(todoListInvitations)
      // invitations by link (token_hash, later) have no invitee and are not listed here
      .innerJoin(users, eq(users.userId, todoListInvitations.inviteeId))
      .where(and(eq(todoListInvitations.listId, listId), isNotNull(todoListInvitations.inviteeId), isOpen()))
      .orderBy(asc(todoListInvitations.createdAt), asc(todoListInvitations.invitationId));

    return rows.map(({ inviteeId, inviteeUsername, ...invitation }) => ({
      ...invitation,
      invitee: { userId: inviteeId, username: inviteeUsername },
    }));
  }

  /** @returns undefined when the list has no such invitation */
  async revokeInvitation(listId: string, invitationId: string): Promise<ListInvitation | undefined> {
    const [revoked] = await db
      .delete(todoListInvitations)
      .where(and(eq(todoListInvitations.listId, listId), eq(todoListInvitations.invitationId, invitationId)))
      .returning();
    if (!revoked) return undefined;

    const [invitee] = revoked.inviteeId
      ? await db.select({ userId: users.userId, username: users.username }).from(users).where(eq(users.userId, revoked.inviteeId))
      : [];
    return {
      invitationId: revoked.invitationId,
      listId: revoked.listId,
      invitee,
      role: revoked.role,
      createdAt: revoked.createdAt,
      expiresAt: revoked.expiresAt,
    };
  }

  async getInvitationById(invitationId: string): Promise<TodoListInvitation | undefined> {
    const [invitation] = await db
      .select()
      .from(todoListInvitations)
      .where(eq(todoListInvitations.invitationId, invitationId))
      .limit(1);
    return invitation;
  }

  /** The open invitations of a user, oldest first. Deletes the expired ones of the user. */
  async getInvitationsForUser(userId: string): Promise<ReceivedInvitation[]> {
    await db.delete(todoListInvitations).where(and(eq(todoListInvitations.inviteeId, userId), isExpired()));

    const rows = await db
      .select({
        invitationId: todoListInvitations.invitationId,
        role: todoListInvitations.role,
        expiresAt: todoListInvitations.expiresAt,
        listId: todoLists.listId,
        listName: todoLists.name,
        inviterId: users.userId,
        inviterUsername: users.username,
      })
      .from(todoListInvitations)
      .innerJoin(todoLists, eq(todoLists.listId, todoListInvitations.listId))
      .innerJoin(users, eq(users.userId, todoListInvitations.invitedBy))
      .where(and(eq(todoListInvitations.inviteeId, userId), isOpen()))
      .orderBy(asc(todoListInvitations.createdAt), asc(todoListInvitations.invitationId));

    return rows.map(({ invitationId, role, expiresAt, listId, listName, inviterId, inviterUsername }) => ({
      invitationId,
      role,
      expiresAt,
      list: { listId, name: listName },
      invitedBy: { userId: inviterId, username: inviterUsername },
    }));
  }

  /**
   * Makes the invited user a member with the role of the invitation. Checked again under the lock of the list: the
   * invitation may have been revoked or the list filled up meanwhile (design 7.2).
   * @throws HttpError 404 unknown, expired or meanwhile revoked invitation, 403 invitation of another user, 409 full list
   */
  async acceptInvitation(invitationId: string, userId: string): Promise<TodoList> {
    const invitation = await this.getOwnOpenInvitation(invitationId, userId);

    return withRetryOnDeadlock(() =>
      db.transaction(async (tx) => {
        // the new member row references the user and the inviter (added_by): lock both before the list
        await lockUsers(tx, [userId, invitation.invitedBy]);
        const list = await lockList(tx, invitation.listId);

        const [current] = await tx
          .select()
          .from(todoListInvitations)
          .where(
            and(
              eq(todoListInvitations.invitationId, invitationId),
              eq(todoListInvitations.inviteeId, userId),
              isOpen(),
            ),
          )
          .for("update");
        if (!current) throw HttpError.notFound("Invitation not found");

        const [{ value: members }] = await tx
          .select({ value: count() })
          .from(todoListMembers)
          .where(eq(todoListMembers.listId, list.listId));
        if (members >= MAX_MEMBERS_PER_LIST) throw HttpError.conflict("List has reached the member limit");

        await tx
          .insert(todoListMembers)
          .values({ listId: list.listId, userId, role: current.role, addedBy: current.invitedBy });
        await tx.delete(todoListInvitations).where(eq(todoListInvitations.invitationId, invitationId));
        return list;
      }),
    );
  }

  /** @throws HttpError 404 unknown or expired invitation, 403 invitation of another user */
  async declineInvitation(invitationId: string, userId: string): Promise<void> {
    await this.getOwnOpenInvitation(invitationId, userId);
    await db
      .delete(todoListInvitations)
      .where(and(eq(todoListInvitations.invitationId, invitationId), eq(todoListInvitations.inviteeId, userId)));
  }

  /**
   * The invitation if it goes to the user and is still open. An expired one is deleted. Only the invited user may
   * answer an invitation, admins included: nobody can be made a member without the own consent.
   */
  private async getOwnOpenInvitation(invitationId: string, userId: string): Promise<TodoListInvitation> {
    const invitation = await this.getInvitationById(invitationId);
    if (!invitation) throw HttpError.notFound("Invitation not found");
    if (invitation.inviteeId !== userId) throw HttpError.forbidden("Invitation of another user");
    if (invitation.expiresAt.getTime() <= Date.now()) {
      await db.delete(todoListInvitations).where(eq(todoListInvitations.invitationId, invitationId));
      throw HttpError.notFound("Invitation not found");
    }
    return invitation;
  }
}

export default TodoListInvitationService;
