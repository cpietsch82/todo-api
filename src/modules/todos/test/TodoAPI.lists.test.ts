import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { todos, users, type User } from "@/db/schema";
import { todoListMembers, todoLists, type MemberRole, type TodoList } from "@modules/todo-lists/schema/todo-list.schema";
import { MAX_TODOS_PER_LIST } from "@modules/todo-lists/limits";
import { TodoAPI } from "@modules/todos/TodoAPI";
import { TodoCommentAPI } from "@modules/todos/TodoCommentAPI";
import { todoComments } from "@modules/todos/schema/todo.comment.schema";
import { createAuthHeader, generateTodo, generateUser, NON_EXISTENT_UUID } from "@tests/test.helpers";
import { getTestServer } from "@tests/integration.setup";

/** a todo record that passes the create schema */
const TODO = { title: "Milch kaufen", description: "", status: "not_ready", tags: [] };

async function createList(ownerId: string, name = "Einkauf"): Promise<TodoList> {
  const [list] = await db.insert(todoLists).values({ name, ownerId }).returning();
  return list;
}

async function addMember(listId: string, userId: string, role: MemberRole) {
  await db.insert(todoListMembers).values({ listId, userId, role });
}

const todoById = async (todoId: string) => (await db.select().from(todos).where(eq(todos.todoId, todoId)))[0];

describe("TodoAPI with lists", () => {
  let server: Server;
  let owner: User;
  let editor: User;
  let viewer: User;
  let stranger: User;
  let list: TodoList;

  beforeAll(() => {
    new TodoAPI();
    new TodoCommentAPI();
    server = getTestServer();
  });

  beforeEach(async () => {
    owner = await generateUser();
    editor = await generateUser();
    viewer = await generateUser();
    stranger = await generateUser();
    list = await createList(owner.userId);
    await addMember(list.listId, editor.userId, "editor");
    await addMember(list.listId, viewer.userId, "viewer");
  });

  const create = async (user: User, todoRecord: object) =>
    request(server)
      .post("/api/todos")
      .set(await createAuthHeader(user))
      .send({ todoRecord });

  const patch = async (user: User, todoId: string, updates: object) =>
    request(server)
      .patch(`/api/todos/${todoId}`)
      .set(await createAuthHeader(user))
      .send({ updates });

  describe("POST /api/todos with a list", () => {
    it("should create the todo in an own list", async () => {
      const response = await create(owner, { ...TODO, listId: list.listId });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ listId: list.listId, userId: owner.userId, version: 1 });
    });

    it("should let an editor add a todo", async () => {
      expect((await create(editor, { ...TODO, listId: list.listId })).status).toBe(201);
    });

    it("should not let a viewer add a todo", async () => {
      const response = await create(viewer, { ...TODO, listId: list.listId });

      expect(response.status).toBe(403);
      expect(await db.select().from(todos)).toHaveLength(0);
    });

    it("should not put a todo into a foreign list", async () => {
      const response = await create(stranger, { ...TODO, listId: list.listId });

      expect(response.status).toBe(403);
      expect(await db.select().from(todos)).toHaveLength(0);
    });

    it("should answer 404 for a list that does not exist", async () => {
      const response = await create(owner, { ...TODO, listId: NON_EXISTENT_UUID });

      expect(response.status).toBe(404);
      expect(response.text).toBe("List not found");
      expect(await db.select().from(todos)).toHaveLength(0);
    });

    it("should refuse a todo when the list is full", async () => {
      await db
        .insert(todos)
        .values(Array.from({ length: MAX_TODOS_PER_LIST }, (_, i) => ({ title: `Todo ${i}`, userId: owner.userId, listId: list.listId })));

      const response = await create(owner, { ...TODO, listId: list.listId });

      expect(response.status).toBe(409);
      expect(response.text).toBe("List is full");
    });

    it("should ignore a version and a creator in the body", async () => {
      const response = await create(owner, { ...TODO, version: 9, userId: stranger.userId });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ version: 1, userId: owner.userId });
    });
  });

  describe("PATCH /api/todos/:todoId moving between lists", () => {
    it("should let the owner of both lists move a todo from one list into the other", async () => {
      const second = await createList(owner.userId, "Baumarkt");
      const todo = await generateTodo(owner.userId, { listId: list.listId });

      const response = await patch(owner, todo.todoId, { listId: second.listId });

      expect(response.status).toBe(201);
      expect((await todoById(todo.todoId)).listId).toBe(second.listId);
    });

    it("should not let an editor move an own todo into a list where they are only viewer", async () => {
      const target = await createList(stranger.userId, "Fremd");
      await addMember(target.listId, editor.userId, "viewer");
      const todo = await generateTodo(editor.userId, { listId: list.listId });

      const response = await patch(editor, todo.todoId, { listId: target.listId, title: "Moved away" });

      expect(response.status).toBe(403);
      expect(await todoById(todo.todoId)).toMatchObject({ listId: list.listId, title: "Test Todo" });
    });

    it("should not let an editor move a todo someone else created into an own list", async () => {
      const own = await createList(editor.userId, "Eigene");
      const todo = await generateTodo(owner.userId, { listId: list.listId });

      const response = await patch(editor, todo.todoId, { listId: own.listId });

      expect(response.status).toBe(403);
      expect((await todoById(todo.todoId)).listId).toBe(list.listId);
    });

    it("should move an own private todo into an own list", async () => {
      const todo = await generateTodo(owner.userId);

      const response = await patch(owner, todo.todoId, { listId: list.listId });

      expect(response.status).toBe(201);
      expect((await todoById(todo.todoId)).listId).toBe(list.listId);
    });

    it("should not move an own todo into a foreign list", async () => {
      const todo = await generateTodo(stranger.userId);

      const response = await patch(stranger, todo.todoId, { listId: list.listId });

      expect(response.status).toBe(403);
      expect((await todoById(todo.todoId)).listId).toBeNull();
    });

    it("should answer 404 when the target list does not exist", async () => {
      const todo = await generateTodo(owner.userId);

      const response = await patch(owner, todo.todoId, { listId: NON_EXISTENT_UUID });

      expect(response.status).toBe(404);
      expect((await todoById(todo.todoId)).listId).toBeNull();
    });

    it("should let the owner take the todo of an editor out of the list, back to its creator", async () => {
      const todo = await generateTodo(editor.userId, { listId: list.listId });

      const response = await patch(owner, todo.todoId, { listId: null });

      expect(response.status).toBe(201);
      expect(await todoById(todo.todoId)).toMatchObject({ listId: null, userId: editor.userId });
    });

    it("should not let an editor take the todo of someone else out of the list", async () => {
      const todo = await generateTodo(owner.userId, { listId: list.listId });

      const response = await patch(editor, todo.todoId, { listId: null });

      expect(response.status).toBe(403);
      expect((await todoById(todo.todoId)).listId).toBe(list.listId);
    });

    it("should keep a todo of a deleted user in its list", async () => {
      const gone = await generateUser();
      const todo = await generateTodo(gone.userId, { listId: list.listId });
      await db.delete(users).where(eq(users.userId, gone.userId));

      const response = await patch(owner, todo.todoId, { listId: null });

      expect(response.status).toBe(409);
      expect(response.text).toBe("A todo of a deleted user cannot leave its list");
      expect((await todoById(todo.todoId)).listId).toBe(list.listId);
    });
  });

  describe("changing and deleting todos in a list", () => {
    it("should let the owner change a todo an editor created", async () => {
      const todo = await generateTodo(editor.userId, { listId: list.listId });

      const response = await patch(owner, todo.todoId, { status: "finished" });

      expect(response.status).toBe(201);
      expect((await todoById(todo.todoId)).status).toBe("finished");
    });

    it("should let an editor change any todo of the list", async () => {
      const todo = await generateTodo(owner.userId, { listId: list.listId });

      expect((await patch(editor, todo.todoId, { status: "finished" })).status).toBe(201);
    });

    it("should not let a viewer change a todo", async () => {
      const todo = await generateTodo(owner.userId, { listId: list.listId });

      const response = await patch(viewer, todo.todoId, { status: "finished" });

      expect(response.status).toBe(403);
      expect((await todoById(todo.todoId)).status).toBe("not_ready");
    });

    it("should let an editor delete an own todo, but not one of someone else", async () => {
      const own = await generateTodo(editor.userId, { listId: list.listId });
      const foreign = await generateTodo(owner.userId, { listId: list.listId });
      const header = await createAuthHeader(editor);

      expect((await request(server).delete(`/api/todos/${own.todoId}`).set(header)).status).toBe(200);
      expect((await request(server).delete(`/api/todos/${foreign.todoId}`).set(header)).status).toBe(403);
      expect(await todoById(foreign.todoId)).toBeDefined();
    });

    it("should let the owner delete any todo of the list", async () => {
      const todo = await generateTodo(editor.userId, { listId: list.listId });

      const response = await request(server).delete(`/api/todos/${todo.todoId}`).set(await createAuthHeader(owner));

      expect(response.status).toBe(200);
    });

    it("should let a viewer read a todo of the list, but not a stranger", async () => {
      const todo = await generateTodo(owner.userId, { listId: list.listId });

      expect((await request(server).get(`/api/todos/${todo.todoId}`).set(await createAuthHeader(viewer))).status).toBe(200);
      expect((await request(server).get(`/api/todos/${todo.todoId}`).set(await createAuthHeader(stranger))).status).toBe(
        403,
      );
    });
  });

  describe("comments on todos of a list", () => {
    const comment = async (user: User, todoId: string) =>
      request(server)
        .post("/api/todo-comments")
        .set(await createAuthHeader(user))
        .send({ commentRecord: { todoId, comment: "Brauchen wir Hafermilch?" } });

    it("should let a viewer of the list comment on its todos", async () => {
      const todo = await generateTodo(owner.userId, { listId: list.listId });

      const response = await comment(viewer, todo.todoId);

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ todoId: todo.todoId, userId: viewer.userId });
    });

    it("should not let a stranger or a removed member comment", async () => {
      const todo = await generateTodo(owner.userId, { listId: list.listId });
      await db.delete(todoListMembers).where(eq(todoListMembers.userId, viewer.userId));

      expect((await comment(stranger, todo.todoId)).status).toBe(403);
      expect((await comment(viewer, todo.todoId)).status).toBe(403);
      expect(await db.select().from(todoComments)).toHaveLength(0);
    });
  });

  describe("GET /api/todos", () => {
    it("should return own todos without list and in lists with access, not in lists the user was removed from", async () => {
      const privateTodo = await generateTodo(editor.userId);
      const inList = await generateTodo(editor.userId, { listId: list.listId });
      const otherList = await createList(stranger.userId, "Fremd");
      await addMember(otherList.listId, editor.userId, "editor");
      const inRemovedList = await generateTodo(editor.userId, { listId: otherList.listId });
      await db.delete(todoListMembers).where(eq(todoListMembers.listId, otherList.listId));
      await generateTodo(owner.userId, { listId: list.listId });

      const response = await request(server).get("/api/todos").set(await createAuthHeader(editor));

      expect(response.status).toBe(200);
      const ids = response.body.map((t: { todoId: string }) => t.todoId);
      expect(ids).toHaveLength(2);
      expect(ids).toEqual(expect.arrayContaining([privateTodo.todoId, inList.todoId]));
      expect(ids).not.toContain(inRemovedList.todoId);
    });

    it("should keep the shape of the response and only add listId and version", async () => {
      await generateTodo(owner.userId);

      const response = await request(server).get("/api/todos").set(await createAuthHeader(owner));

      expect(Object.keys(response.body[0]).sort()).toEqual(
        ["createdAt", "description", "listId", "severity", "status", "tags", "title", "todoId", "updatedAt", "userId", "version"],
      );
    });
  });
});
