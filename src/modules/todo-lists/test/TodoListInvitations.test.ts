import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
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
import { TodoListService } from "@modules/todo-lists/TodoListService";
import { INVITATION_LIFETIME_MS, MAX_MEMBERS_PER_LIST, MAX_OPEN_INVITATIONS_PER_LIST } from "@modules/todo-lists/limits";
import { createAuthHeader, generateUser } from "@tests/test.helpers";
import { getTestServer } from "@tests/integration.setup";

async function createList(ownerId: string, name = "Einkauf"): Promise<TodoList> {
  const [list] = await db.insert(todoLists).values({ name, ownerId }).returning();
  return list;
}

async function addMember(listId: string, userId: string, role: MemberRole) {
  await db.insert(todoListMembers).values({ listId, userId, role });
}

async function insertInvitation(listId: string, inviteeId: string, invitedBy: string, expiresAt = new Date(Date.now() + 60_000)) {
  const [invitation] = await db.insert(todoListInvitations).values({ listId, inviteeId, invitedBy, expiresAt }).returning();
  return invitation;
}

const invitationsOf = async (listId: string) => db.select().from(todoListInvitations).where(eq(todoListInvitations.listId, listId));

describe("Invitations to a todo list (owner side)", () => {
  let server: Server;
  let owner: User;
  let editor: User;
  let viewer: User;
  let stranger: User;
  let max: User;
  let list: TodoList;

  const invite = async (actor: User, body: object, options = {}, listId = list.listId) =>
    request(server)
      .post(`/api/todo-lists/${listId}/invitations`)
      .set(await createAuthHeader(actor, options))
      .send(body);

  beforeAll(() => {
    new TodoListAPI();
    server = getTestServer();
  });

  beforeEach(async () => {
    owner = await generateUser();
    editor = await generateUser();
    viewer = await generateUser();
    stranger = await generateUser();
    max = await generateUser({ username: "max" });
    list = await createList(owner.userId);
    await addMember(list.listId, editor.userId, "editor");
    await addMember(list.listId, viewer.userId, "viewer");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("POST /api/todo-lists/:listId/invitations", () => {
    it("should invite by username regardless of case, spaces and width", async () => {
      const second = await createList(owner.userId, "Zweite");

      const response = await invite(owner, { username: "  MAX " });
      const wide = await invite(owner, { username: "ｍａｘ" }, {}, second.listId);

      expect(response.status).toBe(201);
      expect(wide.status).toBe(201);
      expect(response.body).toMatchObject({
        listId: list.listId,
        invitee: { userId: max.userId, username: "max" },
        role: "viewer",
      });
      expect(Object.keys(response.body.invitee)).toEqual(["userId", "username"]);
      const expiresIn = new Date(response.body.expiresAt).getTime() - Date.now();
      expect(Math.abs(expiresIn - INVITATION_LIFETIME_MS)).toBeLessThan(60_000);
    });

    it("should invite with the given role", async () => {
      const response = await invite(owner, { username: "max", role: "editor" });

      expect(response.status).toBe(201);
      expect(response.body.role).toBe("editor");
    });

    it("should answer 404 for an unknown username", async () => {
      const response = await invite(owner, { username: "niemand" });

      expect(response.status).toBe(404);
      expect(response.text).toBe("User not found");
    });

    it("should answer 400 when inviting oneself", async () => {
      const response = await invite(owner, { username: owner.username });

      expect(response.status).toBe(400);
      expect(response.text).toBe("You cannot invite yourself");
    });

    it("should answer 409 for a member, the owner (as admin) and an open invitation", async () => {
      const admin = await generateUser();
      await invite(owner, { username: "max" });

      const member = await invite(owner, { username: viewer.username });
      const theOwner = await invite(admin, { username: owner.username }, { role: "admin" });
      const again = await invite(owner, { username: "max" });

      expect(member.status).toBe(409);
      expect(member.text).toBe("User is already a member of the list");
      expect(theOwner.status).toBe(409);
      expect(theOwner.text).toBe("User is already a member of the list");
      expect(again.status).toBe(409);
      expect(again.text).toBe("User is already invited");
    });

    it("should replace an expired invitation of the same person", async () => {
      await insertInvitation(list.listId, max.userId, owner.userId, new Date(Date.now() - 1000));

      const response = await invite(owner, { username: "max" });

      expect(response.status).toBe(201);
      const stored = await invitationsOf(list.listId);
      expect(stored).toHaveLength(1);
      expect(stored[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("should refuse role owner", async () => {
      const response = await invite(owner, { username: "max", role: "owner" });

      expect(response.status).toBe(400);
      expect(await invitationsOf(list.listId)).toHaveLength(0);
    });

    it("should answer 409 at the member limit", async () => {
      // two members exist already
      for (let i = 0; i < MAX_MEMBERS_PER_LIST - 2; i++) await addMember(list.listId, (await generateUser()).userId, "viewer");

      const response = await invite(owner, { username: "max" });

      expect(response.status).toBe(409);
      expect(response.text).toBe("List has reached the member limit");
    });

    it("should answer 409 at the invitation limit", async () => {
      for (let i = 0; i < MAX_OPEN_INVITATIONS_PER_LIST; i++) {
        await insertInvitation(list.listId, (await generateUser()).userId, owner.userId);
      }

      const response = await invite(owner, { username: "max" });

      expect(response.status).toBe(409);
      expect(response.text).toBe("List has reached the invitation limit");
    });

    it.each([
      ["editor", 403],
      ["viewer", 403],
      ["stranger", 403],
      ["admin", 201],
    ] as const)("invite as %s → %i", async (actor, status) => {
      const admin = await generateUser();
      const users = { editor, viewer, stranger, admin };

      const response = await invite(users[actor], { username: "max" }, actor === "admin" ? { role: "admin" } : {});

      expect(response.status).toBe(status);
      expect(await invitationsOf(list.listId)).toHaveLength(status === 201 ? 1 : 0);
    });

    it("should answer 409 when the owner changed between check and invitation", async () => {
      vi.spyOn(TodoListService.prototype, "getListById").mockResolvedValue({ ...list, ownerId: stranger.userId });

      const response = await invite(stranger, { username: "max" });

      expect(response.status).toBe(409);
      expect(response.text).toBe("The list changed meanwhile, please try again");
      expect(await invitationsOf(list.listId)).toHaveLength(0);
    });
  });

  describe("GET /api/todo-lists/:listId/invitations", () => {
    it("should list only the open invitations of the list, without e-mail", async () => {
      const expired = await insertInvitation(list.listId, stranger.userId, owner.userId, new Date(Date.now() - 1000));
      const open = await insertInvitation(list.listId, max.userId, owner.userId);
      const other = await createList(stranger.userId, "Fremd");
      await insertInvitation(other.listId, max.userId, stranger.userId);

      const response = await request(server).get(`/api/todo-lists/${list.listId}/invitations`).set(await createAuthHeader(owner));

      expect(response.status).toBe(200);
      expect(response.body).toEqual([
        {
          invitationId: open.invitationId,
          listId: list.listId,
          invitee: { userId: max.userId, username: "max" },
          role: "viewer",
          createdAt: open.createdAt.toISOString(),
          expiresAt: open.expiresAt.toISOString(),
        },
      ]);
      const stored = await invitationsOf(list.listId);
      expect(stored.map((row) => row.invitationId)).not.toContain(expired.invitationId);
    });

    it.each([
      ["editor", 403],
      ["viewer", 403],
    ] as const)("GET invitations as %s → %i", async (actor, status) => {
      const users = { editor, viewer };

      const response = await request(server)
        .get(`/api/todo-lists/${list.listId}/invitations`)
        .set(await createAuthHeader(users[actor]));

      expect(response.status).toBe(status);
    });
  });

  describe("DELETE /api/todo-lists/:listId/invitations/:invitationId", () => {
    it("should revoke an invitation and answer 404 for one of another list", async () => {
      const own = await insertInvitation(list.listId, max.userId, owner.userId);
      const other = await createList(owner.userId, "Andere");
      const foreign = await insertInvitation(other.listId, stranger.userId, owner.userId);

      const revoked = await request(server)
        .delete(`/api/todo-lists/${list.listId}/invitations/${own.invitationId}`)
        .set(await createAuthHeader(owner));
      const wrongList = await request(server)
        .delete(`/api/todo-lists/${list.listId}/invitations/${foreign.invitationId}`)
        .set(await createAuthHeader(owner));

      expect(revoked.status).toBe(200);
      expect(revoked.body.invitationId).toBe(own.invitationId);
      expect(await invitationsOf(list.listId)).toHaveLength(0);
      expect(wrongList.status).toBe(404);
      expect(wrongList.text).toBe("Invitation not found");
      expect(await invitationsOf(other.listId)).toHaveLength(1);
    });

    it("should answer 409 to a revocation when the list was handed over meanwhile", async () => {
      const own = await insertInvitation(list.listId, max.userId, owner.userId);
      vi.spyOn(TodoListService.prototype, "getListById").mockResolvedValue({ ...list, ownerId: stranger.userId });

      const response = await request(server)
        .delete(`/api/todo-lists/${list.listId}/invitations/${own.invitationId}`)
        .set(await createAuthHeader(stranger));

      expect(response.status).toBe(409);
      expect(response.text).toBe("The list changed meanwhile, please try again");
      expect(await invitationsOf(list.listId)).toHaveLength(1);
    });

    it("should not let an editor revoke", async () => {
      const own = await insertInvitation(list.listId, max.userId, owner.userId);

      const response = await request(server)
        .delete(`/api/todo-lists/${list.listId}/invitations/${own.invitationId}`)
        .set(await createAuthHeader(editor));

      expect(response.status).toBe(403);
      expect(await invitationsOf(list.listId)).toHaveLength(1);
    });
  });
});
