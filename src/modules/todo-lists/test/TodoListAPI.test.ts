import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { todos, type User } from "@/db/schema";
import { todoListMembers, todoLists, type MemberRole, type TodoList } from "@modules/todo-lists/schema/todo-list.schema";
import { TodoListAPI } from "@modules/todo-lists/TodoListAPI";
import { MAX_LISTS_PER_USER } from "@modules/todo-lists/limits";
import { createAuthHeader, generateTodo, generateUser, NON_EXISTENT_UUID } from "@tests/test.helpers";
import { getTestServer } from "@tests/integration.setup";

async function createList(ownerId: string, name = "Einkauf"): Promise<TodoList> {
  const [list] = await db.insert(todoLists).values({ name, ownerId }).returning();
  return list;
}

async function addMember(listId: string, userId: string, role: MemberRole) {
  await db.insert(todoListMembers).values({ listId, userId, role });
}

const listById = async (listId: string) => (await db.select().from(todoLists).where(eq(todoLists.listId, listId)))[0];

describe("TodoListAPI", () => {
  let server: Server;
  let owner: User;
  let member: User;
  let stranger: User;

  beforeAll(() => {
    new TodoListAPI();
    server = getTestServer();
  });

  beforeEach(async () => {
    owner = await generateUser();
    member = await generateUser();
    stranger = await generateUser();
  });

  describe("POST /api/todo-lists", () => {
    it("should create a list owned by the requesting user", async () => {
      const response = await request(server)
        .post("/api/todo-lists")
        .set(await createAuthHeader(owner))
        .send({ listRecord: { name: "  Einkauf ", description: "Wocheneinkauf" } });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ name: "Einkauf", description: "Wocheneinkauf", ownerId: owner.userId });
    });

    it("should ignore an owner in the body", async () => {
      const response = await request(server)
        .post("/api/todo-lists")
        .set(await createAuthHeader(owner))
        .send({ listRecord: { name: "Einkauf", ownerId: stranger.userId }, ownerId: stranger.userId });

      expect(response.status).toBe(201);
      expect(response.body.ownerId).toBe(owner.userId);
    });

    it("should refuse more lists than the limit", async () => {
      await db
        .insert(todoLists)
        .values(Array.from({ length: MAX_LISTS_PER_USER }, (_, i) => ({ name: `Liste ${i}`, ownerId: owner.userId })));

      const response = await request(server)
        .post("/api/todo-lists")
        .set(await createAuthHeader(owner))
        .send({ listRecord: { name: "Eine zu viel" } });

      expect(response.status).toBe(409);
      expect(response.text).toBe("List limit reached");
    });

    it("should need the permission todo-lists:create", async () => {
      const response = await request(server)
        .post("/api/todo-lists")
        .set(await createAuthHeader(owner, { permissions: [] }))
        .send({ listRecord: { name: "Einkauf" } });

      expect(response.status).toBe(403);
      expect(await db.select().from(todoLists)).toHaveLength(0);
    });

    it("should answer 400 for an empty name", async () => {
      const response = await request(server)
        .post("/api/todo-lists")
        .set(await createAuthHeader(owner))
        .send({ listRecord: { name: "   " } });

      expect(response.status).toBe(400);
    });
  });

  describe("GET /api/todo-lists", () => {
    it("should return own and shared lists with role and counts, but no foreign ones", async () => {
      const own = await createList(owner.userId, "A eigene");
      const shared = await createList(stranger.userId, "B geteilt");
      await createList(stranger.userId, "C fremd");
      await addMember(shared.listId, owner.userId, "viewer");
      await addMember(own.listId, member.userId, "editor");
      await generateTodo(owner.userId, { listId: own.listId });

      const response = await request(server).get("/api/todo-lists").set(await createAuthHeader(owner));

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2);
      expect(response.body[0]).toMatchObject({ listId: own.listId, myRole: "owner", todoCount: 1, memberCount: 1 });
      expect(response.body[1]).toMatchObject({ listId: shared.listId, myRole: "viewer", todoCount: 0, memberCount: 1 });
    });
  });

  describe("GET /api/todo-lists/:listId", () => {
    it("should return the list to a member", async () => {
      const list = await createList(owner.userId);
      await addMember(list.listId, member.userId, "viewer");

      const response = await request(server).get(`/api/todo-lists/${list.listId}`).set(await createAuthHeader(member));

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ listId: list.listId, myRole: "viewer", memberCount: 1 });
    });

    it("should answer 403 for a stranger, 404 for an unknown list and 400 for an invalid id", async () => {
      const list = await createList(owner.userId);
      const header = await createAuthHeader(stranger);

      expect((await request(server).get(`/api/todo-lists/${list.listId}`).set(header)).status).toBe(403);
      expect((await request(server).get(`/api/todo-lists/${NON_EXISTENT_UUID}`).set(header)).status).toBe(404);
      expect((await request(server).get("/api/todo-lists/no-uuid").set(header)).status).toBe(400);
    });
  });

  describe("PATCH /api/todo-lists/:listId", () => {
    it("should let the owner rename the list", async () => {
      const list = await createList(owner.userId);
      // an old date set from javascript, compared with the one the update sets from javascript as well
      await db.update(todoLists).set({ updatedAt: new Date("2020-01-01") }).where(eq(todoLists.listId, list.listId));

      const response = await request(server)
        .patch(`/api/todo-lists/${list.listId}`)
        .set(await createAuthHeader(owner))
        .send({ updates: { name: "Baumarkt", description: "Schrauben" } });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ name: "Baumarkt", description: "Schrauben" });
      expect(new Date(response.body.updatedAt).getTime()).toBeGreaterThan(new Date("2020-01-01").getTime());
    });

    it("should not let an editor rename the list", async () => {
      const list = await createList(owner.userId);
      await addMember(list.listId, member.userId, "editor");

      const response = await request(server)
        .patch(`/api/todo-lists/${list.listId}`)
        .set(await createAuthHeader(member))
        .send({ updates: { name: "Gekapert" } });

      expect(response.status).toBe(403);
      expect((await listById(list.listId)).name).toBe("Einkauf");
    });

    it("should ignore an owner or a list id in the updates", async () => {
      const list = await createList(owner.userId);

      const response = await request(server)
        .patch(`/api/todo-lists/${list.listId}`)
        .set(await createAuthHeader(owner))
        .send({ updates: { name: "Baumarkt", ownerId: stranger.userId, listId: NON_EXISTENT_UUID } });

      expect(response.status).toBe(200);
      const stored = await listById(list.listId);
      expect(stored.ownerId).toBe(owner.userId);
      expect(stored.name).toBe("Baumarkt");
    });
  });

  describe("DELETE /api/todo-lists/:listId", () => {
    it("should let the owner delete the list and give the todos back", async () => {
      const list = await createList(owner.userId);
      const todo = await generateTodo(owner.userId, { listId: list.listId });

      const response = await request(server).delete(`/api/todo-lists/${list.listId}`).set(await createAuthHeader(owner));

      expect(response.status).toBe(200);
      expect(response.body.listId).toBe(list.listId);
      expect(await listById(list.listId)).toBeUndefined();
      const [stored] = await db.select().from(todos).where(eq(todos.todoId, todo.todoId));
      expect(stored.listId).toBeNull();
    });

    it("should not let a stranger delete the list", async () => {
      const list = await createList(owner.userId);

      const response = await request(server).delete(`/api/todo-lists/${list.listId}`).set(await createAuthHeader(stranger));

      expect(response.status).toBe(403);
      expect(await listById(list.listId)).toBeDefined();
    });
  });

  describe("GET /api/todo-lists/:listId/todos", () => {
    it("should return the todos of the list to a viewer", async () => {
      const list = await createList(owner.userId);
      await addMember(list.listId, member.userId, "viewer");
      const todo = await generateTodo(owner.userId, { listId: list.listId });
      await generateTodo(owner.userId);

      const response = await request(server)
        .get(`/api/todo-lists/${list.listId}/todos`)
        .set(await createAuthHeader(member));

      expect(response.status).toBe(200);
      expect(response.body.map((t: { todoId: string }) => t.todoId)).toEqual([todo.todoId]);
    });

    it("should not show the todos to a stranger", async () => {
      const list = await createList(owner.userId);

      const response = await request(server)
        .get(`/api/todo-lists/${list.listId}/todos`)
        .set(await createAuthHeader(stranger));

      expect(response.status).toBe(403);
    });
  });

  describe("admins", () => {
    it("should let an admin read, rename and delete a foreign list", async () => {
      const list = await createList(owner.userId);
      const header = await createAuthHeader(stranger, { role: "admin" });

      expect((await request(server).get(`/api/todo-lists/${list.listId}`).set(header)).status).toBe(200);
      expect(
        (await request(server).patch(`/api/todo-lists/${list.listId}`).set(header).send({ updates: { name: "Admin" } })).status,
      ).toBe(200);
      expect((await request(server).delete(`/api/todo-lists/${list.listId}`).set(header)).status).toBe(200);
    });
  });
});
