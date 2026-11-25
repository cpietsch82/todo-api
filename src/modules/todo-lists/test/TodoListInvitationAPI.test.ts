import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import type { User } from "@/db/schema";
import {
  todoListInvitations,
  todoListMembers,
  todoLists,
  type MemberRole,
  type TodoList,
} from "@modules/todo-lists/schema/todo-list.schema";
import { TodoListAPI } from "@modules/todo-lists/TodoListAPI";
import { TodoListInvitationAPI } from "@modules/todo-lists/TodoListInvitationAPI";
import { TodoListInvitationService } from "@modules/todo-lists/TodoListInvitationService";
import { MAX_MEMBERS_PER_LIST } from "@modules/todo-lists/limits";
import { createAuthHeader, generateUser, NON_EXISTENT_UUID } from "@tests/test.helpers";
import { getTestServer } from "@tests/integration.setup";

async function createList(ownerId: string, name = "Einkauf"): Promise<TodoList> {
  const [list] = await db.insert(todoLists).values({ name, ownerId }).returning();
  return list;
}

async function addMember(listId: string, userId: string, role: MemberRole) {
  await db.insert(todoListMembers).values({ listId, userId, role });
}

async function insertInvitation(
  listId: string,
  inviteeId: string,
  invitedBy: string,
  { role = "viewer" as MemberRole, expiresAt = new Date(Date.now() + 60_000) } = {},
) {
  const [invitation] = await db.insert(todoListInvitations).values({ listId, inviteeId, invitedBy, role, expiresAt }).returning();
  return invitation;
}

const invitationRow = async (invitationId: string) =>
  (await db.select().from(todoListInvitations).where(eq(todoListInvitations.invitationId, invitationId)))[0];
const memberRow = async (listId: string, userId: string) =>
  (
    await db
      .select()
      .from(todoListMembers)
      .where(and(eq(todoListMembers.listId, listId), eq(todoListMembers.userId, userId)))
  )[0];

describe("Invitations to a todo list (invitee side)", () => {
  let server: Server;
  let owner: User;
  let invitee: User;
  let stranger: User;
  let list: TodoList;

  const post = async (user: User, path: string, options = {}) =>
    request(server)
      .post(`/api/todo-list-invitations/${path}`)
      .set(await createAuthHeader(user, options));

  beforeAll(() => {
    new TodoListAPI();
    new TodoListInvitationAPI();
    server = getTestServer();
  });

  beforeEach(async () => {
    owner = await generateUser({ username: "olga" });
    invitee = await generateUser();
    stranger = await generateUser();
    list = await createList(owner.userId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("GET /api/todo-list-invitations", () => {
    it("should list my open invitations with list name and inviter username, no e-mail", async () => {
      const open = await insertInvitation(list.listId, invitee.userId, owner.userId, { role: "editor" });
      const other = await createList(stranger.userId, "Fremd");
      await insertInvitation(other.listId, invitee.userId, stranger.userId, { expiresAt: new Date(Date.now() - 1000) });
      await insertInvitation(other.listId, owner.userId, stranger.userId);

      const response = await request(server).get("/api/todo-list-invitations").set(await createAuthHeader(invitee));

      expect(response.status).toBe(200);
      expect(response.body).toEqual([
        {
          invitationId: open.invitationId,
          role: "editor",
          expiresAt: open.expiresAt.toISOString(),
          list: { listId: list.listId, name: "Einkauf" },
          invitedBy: { userId: owner.userId, username: "olga" },
        },
      ]);
      // the expired one was deleted when it was touched
      expect(await db.select().from(todoListInvitations).where(eq(todoListInvitations.inviteeId, invitee.userId))).toHaveLength(1);
    });

    it("should need todo-lists:read", async () => {
      const response = await request(server)
        .get("/api/todo-list-invitations")
        .set(await createAuthHeader(invitee, { permissions: [] }));

      expect(response.status).toBe(403);
    });
  });

  describe("POST /api/todo-list-invitations/:invitationId/accept", () => {
    it("should accept: member with the invited role, invitation gone, list readable", async () => {
      const invitation = await insertInvitation(list.listId, invitee.userId, owner.userId, { role: "editor" });

      const response = await post(invitee, `${invitation.invitationId}/accept`);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ listId: list.listId, myRole: "editor", memberCount: 1 });
      expect(await memberRow(list.listId, invitee.userId)).toMatchObject({ role: "editor", addedBy: owner.userId });
      expect(await invitationRow(invitation.invitationId)).toBeUndefined();
      const read = await request(server).get(`/api/todo-lists/${list.listId}`).set(await createAuthHeader(invitee));
      expect(read.status).toBe(200);
    });

    it("should answer 403 for an invitation of another user, also for an admin", async () => {
      const invitation = await insertInvitation(list.listId, invitee.userId, owner.userId);

      const byStranger = await post(stranger, `${invitation.invitationId}/accept`);
      const byAdmin = await post(stranger, `${invitation.invitationId}/accept`, { role: "admin" });

      expect(byStranger.status).toBe(403);
      expect(byAdmin.status).toBe(403);
      expect(await invitationRow(invitation.invitationId)).toBeDefined();
      expect(await memberRow(list.listId, stranger.userId)).toBeUndefined();
    });

    it("should answer 404 for an unknown invitation", async () => {
      const response = await post(invitee, `${NON_EXISTENT_UUID}/accept`);

      expect(response.status).toBe(404);
      expect(response.text).toBe("Invitation not found");
    });

    it("should delete an expired invitation and answer 404", async () => {
      const invitation = await insertInvitation(list.listId, invitee.userId, owner.userId, {
        expiresAt: new Date(Date.now() - 1000),
      });

      const response = await post(invitee, `${invitation.invitationId}/accept`);

      expect(response.status).toBe(404);
      expect(await invitationRow(invitation.invitationId)).toBeUndefined();
      expect(await memberRow(list.listId, invitee.userId)).toBeUndefined();
    });

    it("should answer 409 when the list is full, keeping the invitation", async () => {
      for (let i = 0; i < MAX_MEMBERS_PER_LIST; i++) await addMember(list.listId, (await generateUser()).userId, "viewer");
      const invitation = await insertInvitation(list.listId, invitee.userId, owner.userId);

      const response = await post(invitee, `${invitation.invitationId}/accept`);

      expect(response.status).toBe(409);
      expect(response.text).toBe("List has reached the member limit");
      expect(await invitationRow(invitation.invitationId)).toBeDefined();
    });

    it("should answer 404 when the invitation was revoked between reading and locking", async () => {
      const invitation = await insertInvitation(list.listId, invitee.userId, owner.userId);
      const read = TodoListInvitationService.prototype.getInvitationById;
      vi.spyOn(TodoListInvitationService.prototype, "getInvitationById").mockImplementation(async function (
        this: TodoListInvitationService,
        ...args
      ) {
        const found = await read.apply(this, args);
        await db.delete(todoListInvitations).where(eq(todoListInvitations.invitationId, invitation.invitationId));
        return found;
      });

      const response = await post(invitee, `${invitation.invitationId}/accept`);

      expect(response.status).toBe(404);
      expect(await memberRow(list.listId, invitee.userId)).toBeUndefined();
    });

    it("should answer 400 for an invitationId that is no uuid", async () => {
      const response = await post(invitee, "abc/accept");

      expect(response.status).toBe(400);
    });
  });

  describe("POST /api/todo-list-invitations/:invitationId/decline", () => {
    it("should decline: invitation gone, no member", async () => {
      const invitation = await insertInvitation(list.listId, invitee.userId, owner.userId);

      const response = await post(invitee, `${invitation.invitationId}/decline`);

      expect(response.status).toBe(204);
      expect(await invitationRow(invitation.invitationId)).toBeUndefined();
      expect(await memberRow(list.listId, invitee.userId)).toBeUndefined();
    });

    it("should answer 403 for an invitation of another user", async () => {
      const invitation = await insertInvitation(list.listId, invitee.userId, owner.userId);

      const response = await post(stranger, `${invitation.invitationId}/decline`);

      expect(response.status).toBe(403);
      expect(await invitationRow(invitation.invitationId)).toBeDefined();
    });
  });

  it("should be registered in the app", () => {
    expect(readFileSync("src/index.ts", "utf8")).toContain("new TodoListInvitationAPI()");
  });
});
