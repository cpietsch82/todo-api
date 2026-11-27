import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import type { Todo, User } from "@/db/schema";
import { todoListMembers, todoLists, type TodoList } from "@modules/todo-lists/schema/todo-list.schema";
import { TodoAPI } from "@modules/todos/TodoAPI";
import { TodoCommentAPI } from "@modules/todos/TodoCommentAPI";
import { todoComments } from "@modules/todos/schema/todo.comment.schema";
import {
  createAuthHeader,
  generateTodo,
  generateTodoComment,
  generateUser,
  NON_EXISTENT_UUID,
} from "@tests/test.helpers";
import { getTestServer } from "@tests/integration.setup";

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

describe("Pages of the discussion of a todo", () => {
  let server: Server;
  let owner: User;
  let editor: User;
  let viewer: User;
  let list: TodoList;
  let todo: Todo;

  beforeAll(() => {
    new TodoAPI();
    new TodoCommentAPI();
    server = getTestServer();
  });

  beforeEach(async () => {
    owner = await generateUser();
    editor = await generateUser();
    viewer = await generateUser({ username: "vera" });
    [list] = await db.insert(todoLists).values({ name: "Einkauf", ownerId: owner.userId }).returning();
    await db.insert(todoListMembers).values([
      { listId: list.listId, userId: editor.userId, role: "editor" },
      { listId: list.listId, userId: viewer.userId, role: "viewer" },
    ]);
    todo = await generateTodo(editor.userId, { listId: list.listId });
  });

  const get = async (user: User, todoId: string, query = "") =>
    request(server)
      .get(`/api/todos/${todoId}/comments${query}`)
      .set(await createAuthHeader(user));

  const collectAllPages = async (user: User, todoId: string, limit: number): Promise<string[]> => {
    const seen: string[] = [];
    let query = `?limit=${limit}`;
    for (let i = 0; i < 20; i++) {
      const response = await get(user, todoId, query);
      seen.push(...response.body.items.map((c: { commentId: string }) => c.commentId));
      if (!response.body.nextCursor) break;
      query = `?limit=${limit}&before=${response.body.nextCursor}`;
    }
    return seen;
  };

  describe("GET /api/todos/:todoId/comments", () => {
    it("should return the newest page oldest first, with total, lastCommentAt and a cursor to older ones", async () => {
      await db.insert(todoComments).values(
        range(0, 25).map((i) => ({
          todoId: todo.todoId,
          userId: owner.userId,
          comment: `c${i}`,
          createdAt: new Date(Date.UTC(2026, 10, 27, 10, 0, i)),
        })),
      );

      const first = await get(viewer, todo.todoId);
      expect(first.status).toBe(200);
      expect(first.body.items.map((c: { comment: string }) => c.comment)).toEqual(range(5, 25).map((i) => `c${i}`));
      expect(first.body.total).toBe(25);
      expect(first.body.lastCommentAt).toBe("2026-11-27T10:00:24.000Z");

      const second = await get(viewer, todo.todoId, `?before=${first.body.nextCursor}`);
      expect(second.body.items.map((c: { comment: string }) => c.comment)).toEqual(range(0, 5).map((i) => `c${i}`));
      expect(second.body.nextCursor).toBeNull();
    });

    it("should neither skip nor repeat comments with the same createdAt", async () => {
      const createdAt = new Date("2026-11-27T10:00:00Z");
      await db
        .insert(todoComments)
        .values(range(0, 5).map((i) => ({ todoId: todo.todoId, userId: owner.userId, comment: `c${i}`, createdAt })));

      const seen = await collectAllPages(viewer, todo.todoId, 2);

      expect(new Set(seen).size).toBe(5);
      expect(seen).toHaveLength(5);
    });

    it("should only list top-level comments, each with its replyCount", async () => {
      const parent = await generateTodoComment(todo.todoId, owner.userId);
      await generateTodoComment(todo.todoId, viewer.userId, { parentCommentId: parent.commentId });

      const response = await get(viewer, todo.todoId);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0]).toMatchObject({
        commentId: parent.commentId,
        parentCommentId: null,
        replyCount: 1,
        deleted: false,
        edited: false,
      });
      expect(response.body.total).toBe(2);
    });

    it("should answer 400 for a well-formed cursor with an impossible date", async () => {
      const cursor = Buffer.from(JSON.stringify(["2026-02-30 10:00:00", "3f2a5b1e-0000-4000-8000-000000000001"])).toString(
        "base64url",
      );
      expect((await get(viewer, todo.todoId, `?before=${cursor}`)).status).toBe(400);
    });

    it.each(["?limit=0", "?limit=51", "?limit=abc", "?before=kaputt"])("should answer 400 for %s", async (query) => {
      expect((await get(viewer, todo.todoId, query)).status).toBe(400);
    });
  });

  const post = async (user: User, commentRecord: object) =>
    request(server)
      .post("/api/todo-comments")
      .set(await createAuthHeader(user))
      .send({ commentRecord });

  const countComments = async (todoId: string) =>
    (await db.select().from(todoComments).where(eq(todoComments.todoId, todoId))).length;

  const placeholder = async (todoId: string, extra: object = {}) =>
    (
      await db
        .insert(todoComments)
        .values({ todoId, userId: null, comment: null, deletedAt: new Date(), ...extra })
        .returning()
    )[0];

  describe("POST /api/todo-comments with parentCommentId", () => {
    it("should let a viewer answer a comment and return it in the discussion shape", async () => {
      const parent = await generateTodoComment(todo.todoId, owner.userId);
      const response = await post(viewer, { todoId: todo.todoId, comment: "Antwort", parentCommentId: parent.commentId });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        parentCommentId: parent.commentId,
        author: { userId: viewer.userId, username: "vera" },
        replyCount: 0,
        deleted: false,
      });
      expect(response.body.author.email).toBeUndefined();
    });

    it("should refuse a parent from another todo and create nothing", async () => {
      const otherTodo = await generateTodo(owner.userId, { listId: list.listId });
      const foreignParent = await generateTodoComment(otherTodo.todoId, owner.userId);
      const response = await post(viewer, { todoId: todo.todoId, comment: "x", parentCommentId: foreignParent.commentId });
      expect(response.status).toBe(400);
      expect(response.text).toBe("Invalid parent comment");
      expect(await countComments(todo.todoId)).toBe(0);
    });

    it("should refuse to answer a deleted comment", async () => {
      const parent = await placeholder(todo.todoId);
      const response = await post(viewer, { todoId: todo.todoId, comment: "x", parentCommentId: parent.commentId });
      expect(response.status).toBe(400);
      expect(response.text).toBe("Invalid parent comment");
    });

    it("should refuse an unknown parent", async () => {
      const response = await post(viewer, { todoId: todo.todoId, comment: "x", parentCommentId: NON_EXISTENT_UUID });
      expect(response.status).toBe(400);
      expect(response.text).toBe("Invalid parent comment");
    });
  });

  describe("GET /api/todo-comments/:commentId/replies", () => {
    const getReplies = async (user: User, commentId: string, query = "") =>
      request(server)
        .get(`/api/todo-comments/${commentId}/replies${query}`)
        .set(await createAuthHeader(user));

    it("should page the direct replies oldest first, also below a placeholder", async () => {
      const parent = await placeholder(todo.todoId);
      await db.insert(todoComments).values(
        range(0, 3).map((i) => ({
          todoId: todo.todoId,
          userId: owner.userId,
          comment: `r${i}`,
          parentCommentId: parent.commentId,
          createdAt: new Date(Date.UTC(2026, 10, 27, 10, 0, i)),
        })),
      );

      const first = await getReplies(viewer, parent.commentId, "?limit=2");
      expect(first.status).toBe(200);
      expect(first.body.items.map((c: { comment: string }) => c.comment)).toEqual(["r1", "r2"]);
      expect(first.body.total).toBe(3);

      const second = await getReplies(viewer, parent.commentId, `?limit=2&before=${first.body.nextCursor}`);
      expect(second.body.items.map((c: { comment: string }) => c.comment)).toEqual(["r0"]);
      expect(second.body.nextCursor).toBeNull();
    });

    it("should refuse a stranger and a removed member", async () => {
      const parent = await generateTodoComment(todo.todoId, owner.userId);
      const stranger = await generateUser();
      expect((await getReplies(stranger, parent.commentId)).status).toBe(403);

      await db.delete(todoListMembers).where(eq(todoListMembers.userId, viewer.userId));
      expect((await getReplies(viewer, parent.commentId)).status).toBe(403);
    });

    it("should answer 404 for an unknown comment", async () => {
      expect((await getReplies(viewer, NON_EXISTENT_UUID)).status).toBe(404);
    });
  });

  describe("PATCH /api/todo-comments/:commentId", () => {
    const patch = async (user: User, commentId: string, comment: string, role?: "admin") =>
      request(server)
        .patch(`/api/todo-comments/${commentId}`)
        .set(await createAuthHeader(user, role ? { role } : undefined))
        .send({ updates: { comment } });

    it("should mark the comment as edited", async () => {
      const past = new Date(Date.now() - 60_000);
      const [existing] = await db
        .insert(todoComments)
        .values({ todoId: todo.todoId, userId: editor.userId, comment: "alt", createdAt: past, updatedAt: past })
        .returning();
      const response = await patch(editor, existing.commentId, "neu");
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ comment: "neu", edited: true, author: { userId: editor.userId } });
      expect(new Date(response.body.updatedAt).getTime()).toBeGreaterThan(new Date(response.body.createdAt).getTime());
    });

    it("should answer 404 for a placeholder", async () => {
      const parent = await placeholder(todo.todoId);
      expect((await patch(editor, parent.commentId, "x")).status).toBe(404);
      const admin = await generateUser();
      expect((await patch(admin, parent.commentId, "x", "admin")).status).toBe(404);
    });
  });
});
