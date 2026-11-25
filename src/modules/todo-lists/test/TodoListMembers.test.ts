import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { todos, type User } from "@/db/schema";
import { todoListMembers, todoLists, type MemberRole, type TodoList } from "@modules/todo-lists/schema/todo-list.schema";
import { TodoListAPI } from "@modules/todo-lists/TodoListAPI";
import { TodoListService } from "@modules/todo-lists/TodoListService";
import { createAuthHeader, generateTodo, generateUser } from "@tests/test.helpers";
import { getTestServer } from "@tests/integration.setup";

async function createList(ownerId: string, name = "Einkauf"): Promise<TodoList> {
  const [list] = await db.insert(todoLists).values({ name, ownerId }).returning();
  return list;
}

async function addMember(listId: string, userId: string, role: MemberRole) {
  await db.insert(todoListMembers).values({ listId, userId, role });
}

const memberRow = async (listId: string, userId: string) =>
  (
    await db
      .select()
      .from(todoListMembers)
      .where(and(eq(todoListMembers.listId, listId), eq(todoListMembers.userId, userId)))
  )[0];

type Actor = "owner" | "editor" | "viewer" | "removed" | "stranger" | "admin";

describe("Members of a todo list", () => {
  let server: Server;
  let owner: User;
  let editor: User;
  let viewer: User;
  let removed: User;
  let stranger: User;
  let admin: User;
  let list: TodoList;

  const headerOf = (actor: Actor) => {
    const users = { owner, editor, viewer, removed, stranger, admin };
    return createAuthHeader(users[actor], actor === "admin" ? { role: "admin" } : {});
  };

  beforeAll(() => {
    new TodoListAPI();
    server = getTestServer();
  });

  beforeEach(async () => {
    owner = await generateUser({ username: "olga" });
    editor = await generateUser({ username: "emil" });
    viewer = await generateUser({ username: "vera" });
    removed = await generateUser();
    stranger = await generateUser();
    admin = await generateUser();
    list = await createList(owner.userId);
    await addMember(list.listId, editor.userId, "editor");
    await addMember(list.listId, viewer.userId, "viewer");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("GET /api/todo-lists/:listId/members", () => {
    it("should list the owner first and the members by username, without e-mail or names", async () => {
      const response = await request(server).get(`/api/todo-lists/${list.listId}/members`).set(await headerOf("viewer"));

      expect(response.status).toBe(200);
      expect(response.body).toEqual([
        { userId: owner.userId, username: "olga", role: "owner" },
        { userId: editor.userId, username: "emil", role: "editor" },
        { userId: viewer.userId, username: "vera", role: "viewer" },
      ]);
    });

    it.each<[Actor, number]>([
      ["owner", 200],
      ["editor", 200],
      ["viewer", 200],
      ["removed", 403],
      ["stranger", 403],
      ["admin", 200],
    ])("GET members as %s → %i", async (actor, status) => {
      const response = await request(server).get(`/api/todo-lists/${list.listId}/members`).set(await headerOf(actor));

      expect(response.status).toBe(status);
    });
  });

  describe("PATCH /api/todo-lists/:listId/members/:userId", () => {
    const changeRole = async (actor: Actor, userId: string, role: string) =>
      request(server)
        .patch(`/api/todo-lists/${list.listId}/members/${userId}`)
        .set(await headerOf(actor))
        .send({ role });

    it.each<[Actor, number]>([
      ["owner", 200],
      ["editor", 403],
      ["viewer", 403],
      ["stranger", 403],
      ["admin", 200],
    ])("PATCH role as %s → %i", async (actor, status) => {
      const response = await changeRole(actor, viewer.userId, "editor");

      expect(response.status).toBe(status);
      expect((await memberRow(list.listId, viewer.userId)).role).toBe(status === 200 ? "editor" : "viewer");
    });

    it("should answer with the changed member", async () => {
      const response = await changeRole("owner", viewer.userId, "editor");

      expect(response.body).toEqual({ userId: viewer.userId, username: "vera", role: "editor" });
    });

    it("should refuse role owner in the body", async () => {
      const response = await changeRole("owner", viewer.userId, "owner");

      expect(response.status).toBe(400);
      expect((await memberRow(list.listId, viewer.userId)).role).toBe("viewer");
    });

    it("should answer 409 for the owner as target", async () => {
      const response = await changeRole("admin", owner.userId, "viewer");

      expect(response.status).toBe(409);
      expect(response.text).toBe("The owner has no member role");
    });

    it("should answer 404 for a member of another list", async () => {
      const otherList = await createList(stranger.userId, "Andere");
      await addMember(otherList.listId, removed.userId, "viewer");

      const response = await changeRole("owner", removed.userId, "editor");

      expect(response.status).toBe(404);
      expect(response.text).toBe("Member not found");
      expect((await memberRow(otherList.listId, removed.userId)).role).toBe("viewer");
    });

    it("should not let an editor promote himself", async () => {
      const response = await changeRole("editor", editor.userId, "editor");

      expect(response.status).toBe(403);
    });

    it("should need todo-lists:share", async () => {
      const response = await request(server)
        .patch(`/api/todo-lists/${list.listId}/members/${viewer.userId}`)
        .set(await createAuthHeader(owner, { permissions: ["todo-lists:read"] }))
        .send({ role: "editor" });

      expect(response.status).toBe(403);
    });
  });

  describe("DELETE /api/todo-lists/:listId/members/:userId", () => {
    const remove = async (actor: Actor, userId: string) =>
      request(server)
        .delete(`/api/todo-lists/${list.listId}/members/${userId}`)
        .set(await headerOf(actor));

    it("should let a viewer and an editor leave", async () => {
      for (const [actor, user] of [
        ["viewer", viewer],
        ["editor", editor],
      ] as const) {
        const response = await remove(actor, user.userId);

        expect(response.status).toBe(200);
        expect(response.body.userId).toBe(user.userId);
        expect(await memberRow(list.listId, user.userId)).toBeUndefined();
        expect((await request(server).get(`/api/todo-lists/${list.listId}`).set(await headerOf(actor))).status).toBe(403);
      }
    });

    it("should keep the todos of a member who leaves in the list", async () => {
      const todo = await generateTodo(editor.userId, { listId: list.listId });

      await remove("editor", editor.userId);

      const [stored] = await db.select().from(todos).where(eq(todos.todoId, todo.todoId));
      expect(stored.listId).toBe(list.listId);
    });

    it.each<[Actor, number]>([
      ["owner", 200],
      ["editor", 403],
      ["viewer", 403],
      ["stranger", 403],
      ["admin", 200],
    ])("DELETE another member as %s → %i", async (actor, status) => {
      const target = await generateUser();
      await addMember(list.listId, target.userId, "viewer");

      const response = await remove(actor, target.userId);

      expect(response.status).toBe(status);
      expect(await memberRow(list.listId, target.userId)).toEqual(status === 200 ? undefined : expect.anything());
    });

    it("should not let the owner leave or be removed", async () => {
      for (const actor of ["owner", "admin"] as const) {
        const response = await remove(actor, owner.userId);

        expect(response.status).toBe(409);
        expect(response.text).toBe("The owner cannot leave the list, transfer it first");
      }
      expect((await db.select().from(todoLists).where(eq(todoLists.listId, list.listId)))[0].ownerId).toBe(owner.userId);
    });

    it("should answer 404 for someone who is not a member", async () => {
      const response = await remove("owner", stranger.userId);

      expect(response.status).toBe(404);
      expect(response.text).toBe("Member not found");
    });

    it("should need todo-lists:share to remove others", async () => {
      const response = await request(server)
        .delete(`/api/todo-lists/${list.listId}/members/${viewer.userId}`)
        .set(await createAuthHeader(owner, { permissions: ["todo-lists:read"] }));

      expect(response.status).toBe(403);
      expect(await memberRow(list.listId, viewer.userId)).toBeDefined();
    });

    it("should answer 409 when the owner changed between check and removal", async () => {
      // the middleware gets a stale list naming the stranger as owner, the database knows the real owner
      vi.spyOn(TodoListService.prototype, "getListById").mockResolvedValue({ ...list, ownerId: stranger.userId });

      const response = await remove("stranger", viewer.userId);

      expect(response.status).toBe(409);
      expect(response.text).toBe("The list changed meanwhile, please try again");
      expect(await memberRow(list.listId, viewer.userId)).toBeDefined();
    });
  });
});
