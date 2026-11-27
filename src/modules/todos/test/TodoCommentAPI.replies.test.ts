import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import type { Todo, User } from "@/db/schema";
import { todoListMembers, todoLists, type TodoList } from "@modules/todo-lists/schema/todo-list.schema";
import { TodoAPI } from "@modules/todos/TodoAPI";
import { TodoCommentAPI } from "@modules/todos/TodoCommentAPI";
import { todoComments } from "@modules/todos/schema/todo.comment.schema";
import { TodoCommentService } from "@modules/todos/TodoCommentService";
import {
  createAuthHeader,
  generateTodo,
  generateTodoComment,
  generateUser,
  NON_EXISTENT_UUID,
} from "@tests/test.helpers";
import { getTestServer } from "@tests/integration.setup";
import { logger } from "@/utils/logger";

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

  afterEach(() => {
    vi.restoreAllMocks();
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

  const commentById = async (commentId: string) =>
    (await db.select().from(todoComments).where(eq(todoComments.commentId, commentId)))[0];

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

    it("should not write text back into a placeholder when the service is asked to update it", async () => {
      const parent = await placeholder(todo.todoId);

      const result = await new TodoCommentService().updateTodoComment(parent.commentId, { comment: "zurück" });

      expect(result).toBeUndefined();
      expect(await commentById(parent.commentId)).toMatchObject({ comment: null, deletedAt: expect.any(Date) });
    });
  });

  describe("DELETE /api/todo-comments/:commentId", () => {
    const remove = async (user: User, commentId: string, query = "", admin = false) =>
      request(server)
        .delete(`/api/todo-comments/${commentId}${query}`)
        .set(await createAuthHeader(user, admin ? { permissions: ["admin:all", "todo-comments:delete"] } : undefined));

    it("should leave a placeholder when the author deletes a comment with replies", async () => {
      const parent = await generateTodoComment(todo.todoId, owner.userId);
      const reply = await generateTodoComment(todo.todoId, viewer.userId, { parentCommentId: parent.commentId });

      const response = await remove(owner, parent.commentId);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ commentId: parent.commentId, mode: "soft", removedCommentIds: [] });
      expect(await commentById(parent.commentId)).toMatchObject({ comment: null, deletedAt: expect.any(Date) });
      expect(await commentById(reply.commentId)).toBeDefined();
    });

    it("should delete a comment without replies completely", async () => {
      const comment = await generateTodoComment(todo.todoId, viewer.userId);

      const response = await remove(viewer, comment.commentId);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        commentId: comment.commentId,
        mode: "hard",
        removedCommentIds: [comment.commentId],
      });
      expect(await commentById(comment.commentId)).toBeUndefined();
    });

    it("should remove an empty placeholder together with its last reply", async () => {
      const parent = await placeholder(todo.todoId);
      const reply = await generateTodoComment(todo.todoId, viewer.userId, { parentCommentId: parent.commentId });

      const response = await remove(viewer, reply.commentId);

      expect(response.status).toBe(200);
      expect(response.body.mode).toBe("hard");
      expect(response.body.removedCommentIds).toEqual([reply.commentId, parent.commentId]);
      expect(await countComments(todo.todoId)).toBe(0);
    });

    it("should remove placeholders over several levels, but keep one that still has replies", async () => {
      const root = await placeholder(todo.todoId);
      const sibling = await generateTodoComment(todo.todoId, owner.userId, { parentCommentId: root.commentId });
      const middle = await placeholder(todo.todoId, { parentCommentId: root.commentId });
      const reply = await generateTodoComment(todo.todoId, viewer.userId, { parentCommentId: middle.commentId });

      const response = await remove(viewer, reply.commentId);

      expect(response.body.removedCommentIds).toEqual([reply.commentId, middle.commentId]);
      expect(await commentById(root.commentId)).toBeDefined();
      expect(await commentById(sibling.commentId)).toBeDefined();
    });

    it("should answer 404 for a plain delete of a placeholder", async () => {
      const parent = await placeholder(todo.todoId);
      await generateTodoComment(todo.todoId, viewer.userId, { parentCommentId: parent.commentId });

      const response = await remove(owner, parent.commentId);

      expect(response.status).toBe(404);
      expect(await commentById(parent.commentId)).toBeDefined();
    });

    it("should let the list owner and an admin remove a whole thread of others", async () => {
      const admin = await generateUser();
      for (const [moderator, asAdmin] of [
        [owner, false],
        [admin, true],
      ] as const) {
        const parent = await generateTodoComment(todo.todoId, viewer.userId);
        const reply = await generateTodoComment(todo.todoId, editor.userId, { parentCommentId: parent.commentId });
        await generateTodoComment(todo.todoId, viewer.userId, { parentCommentId: reply.commentId });

        const response = await remove(moderator, parent.commentId, "?scope=branch", asAdmin);

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ commentId: parent.commentId, mode: "branch", removedCount: 3 });
        expect(await countComments(todo.todoId)).toBe(0);
      }
    });

    it("should let a moderator remove a placeholder as a thread", async () => {
      const parent = await placeholder(todo.todoId);
      await generateTodoComment(todo.todoId, viewer.userId, { parentCommentId: parent.commentId });

      const response = await remove(owner, parent.commentId, "?scope=branch");

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ commentId: parent.commentId, mode: "branch", removedCount: 2 });
      expect(await countComments(todo.todoId)).toBe(0);
    });

    it("should remove the emptied placeholder above a removed thread", async () => {
      const root = await placeholder(todo.todoId);
      const parent = await generateTodoComment(todo.todoId, viewer.userId, { parentCommentId: root.commentId });
      await generateTodoComment(todo.todoId, editor.userId, { parentCommentId: parent.commentId });

      const response = await remove(owner, parent.commentId, "?scope=branch");

      expect(response.body).toMatchObject({
        mode: "branch",
        removedCount: 2,
        removedCommentIds: [parent.commentId, root.commentId],
      });
      expect(await countComments(todo.todoId)).toBe(0);
    });

    it("should refuse a whole thread to the author without moderation right", async () => {
      const parent = await generateTodoComment(todo.todoId, viewer.userId);
      await generateTodoComment(todo.todoId, editor.userId, { parentCommentId: parent.commentId });
      const warn = vi.spyOn(logger, "warn");

      const response = await remove(viewer, parent.commentId, "?scope=branch");

      expect(response.status).toBe(403);
      // the reason is only logged, the client gets the general text
      expect(response.text).toBe("Insufficient Permissions!");
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "Only moderators may delete a whole thread" }),
        "Access denied",
      );
      expect(await countComments(todo.todoId)).toBe(2);
    });

    it("should still let a moderator choose the placeholder variant on a comment of others", async () => {
      const parent = await generateTodoComment(todo.todoId, viewer.userId);
      await generateTodoComment(todo.todoId, editor.userId, { parentCommentId: parent.commentId });

      const response = await remove(owner, parent.commentId);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ commentId: parent.commentId, mode: "soft", removedCommentIds: [] });
    });

    it("should answer 400 for an unknown scope", async () => {
      const comment = await generateTodoComment(todo.todoId, viewer.userId);

      const response = await remove(owner, comment.commentId, "?scope=all");

      expect(response.status).toBe(400);
      expect(await commentById(comment.commentId)).toBeDefined();
    });
  });
});
