import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import type { Todo, User } from "@/db/schema";
import { todoListMembers, todoLists, type MemberRole, type TodoList } from "@modules/todo-lists/schema/todo-list.schema";
import { TodoAPI } from "@modules/todos/TodoAPI";
import { TodoCommentAPI } from "@modules/todos/TodoCommentAPI";
import { todoComments } from "@modules/todos/schema/todo.comment.schema";
import { createAuthHeader, generateTodo, generateTodoComment, generateUser } from "@tests/test.helpers";
import { getTestServer } from "@tests/integration.setup";

async function createList(ownerId: string, name = "Einkauf"): Promise<TodoList> {
  const [list] = await db.insert(todoLists).values({ name, ownerId }).returning();
  return list;
}

async function addMember(listId: string, userId: string, role: MemberRole) {
  await db.insert(todoListMembers).values({ listId, userId, role });
}

const commentById = async (commentId: string) =>
  (await db.select().from(todoComments).where(eq(todoComments.commentId, commentId)))[0];

describe("Discussion of todos in a list", () => {
  let server: Server;
  let owner: User;
  let editor: User;
  let viewer: User;
  let stranger: User;
  let list: TodoList;
  let todo: Todo;

  const removeFromList = (user: User) =>
    db.delete(todoListMembers).where(and(eq(todoListMembers.listId, list.listId), eq(todoListMembers.userId, user.userId)));

  beforeAll(() => {
    new TodoAPI();
    new TodoCommentAPI();
    server = getTestServer();
  });

  beforeEach(async () => {
    owner = await generateUser();
    editor = await generateUser();
    viewer = await generateUser({ username: "vera" });
    stranger = await generateUser();
    list = await createList(owner.userId);
    await addMember(list.listId, editor.userId, "editor");
    await addMember(list.listId, viewer.userId, "viewer");
    todo = await generateTodo(editor.userId, { listId: list.listId });
  });

  describe("GET /api/todos/:todoId/comments", () => {
    it("should show the discussion of a list todo to every role, with author username, oldest first", async () => {
      // written in a different order than created, so the order comes from createdAt
      await db.insert(todoComments).values([
        { todoId: todo.todoId, userId: viewer.userId, comment: "zweiter", createdAt: new Date("2026-11-25T10:05:00Z") },
        { todoId: todo.todoId, userId: owner.userId, comment: "erster", createdAt: new Date("2026-11-25T10:00:00Z") },
      ]);

      for (const user of [owner, editor, viewer]) {
        const response = await request(server)
          .get(`/api/todos/${todo.todoId}/comments`)
          .set(await createAuthHeader(user));

        expect(response.status).toBe(200);
        expect(response.body.items.map((comment: { comment: string }) => comment.comment)).toEqual(["erster", "zweiter"]);
        expect(response.body.items[1].author).toEqual({ userId: viewer.userId, username: "vera" });
      }
    });

    it("should refuse the discussion to a stranger and a removed member", async () => {
      await generateTodoComment(todo.todoId, viewer.userId);
      await removeFromList(viewer);

      for (const user of [stranger, viewer]) {
        const response = await request(server)
          .get(`/api/todos/${todo.todoId}/comments`)
          .set(await createAuthHeader(user));

        expect(response.status).toBe(403);
      }
    });

    it("should need todo-comments:read", async () => {
      const response = await request(server)
        .get(`/api/todos/${todo.todoId}/comments`)
        .set(await createAuthHeader(owner, { permissions: ["todos:read"] }));

      expect(response.status).toBe(403);
    });
  });

  describe("DELETE /api/todo-comments/:commentId", () => {
    const remove = async (user: User, commentId: string) =>
      request(server)
        .delete(`/api/todo-comments/${commentId}`)
        .set(await createAuthHeader(user));

    it("should let the list owner delete a comment of a viewer", async () => {
      const comment = await generateTodoComment(todo.todoId, viewer.userId);

      const response = await remove(owner, comment.commentId);

      expect(response.status).toBe(200);
      expect(await commentById(comment.commentId)).toBeUndefined();
    });

    it("should not let an editor delete a comment of a viewer, even on the own todo", async () => {
      const comment = await generateTodoComment(todo.todoId, viewer.userId);

      const response = await remove(editor, comment.commentId);

      expect(response.status).toBe(403);
      expect(await commentById(comment.commentId)).toBeDefined();
    });

    it("should let the author delete the own comment", async () => {
      const comment = await generateTodoComment(todo.todoId, viewer.userId);

      const response = await remove(viewer, comment.commentId);

      expect(response.status).toBe(200);
    });

    it("should still let the creator of a todo without list moderate it", async () => {
      const ownTodo = await generateTodo(stranger.userId);
      const comment = await generateTodoComment(ownTodo.todoId, viewer.userId);

      const response = await remove(stranger, comment.commentId);

      expect(response.status).toBe(200);
    });

    it("should answer 404 for an unknown comment", async () => {
      const response = await remove(owner, "00000000-0000-4000-8000-000000000000");

      expect(response.status).toBe(404);
    });
  });

  describe("PATCH /api/todo-comments/:commentId", () => {
    const change = async (user: User, commentId: string) =>
      request(server)
        .patch(`/api/todo-comments/${commentId}`)
        .set(await createAuthHeader(user))
        .send({ updates: { comment: "geändert" } });

    it("should let a member change the own comment", async () => {
      const comment = await generateTodoComment(todo.todoId, viewer.userId);

      const response = await change(viewer, comment.commentId);

      expect(response.status).toBe(200);
      expect((await commentById(comment.commentId)).comment).toBe("geändert");
    });

    it("should not let a removed member change the own comment anymore", async () => {
      const comment = await generateTodoComment(todo.todoId, viewer.userId, { comment: "alt" });
      await removeFromList(viewer);

      const response = await change(viewer, comment.commentId);

      expect(response.status).toBe(403);
      expect((await commentById(comment.commentId)).comment).toBe("alt");
    });

    it("should not let the list owner change a comment of someone else", async () => {
      const comment = await generateTodoComment(todo.todoId, viewer.userId, { comment: "alt" });

      const response = await change(owner, comment.commentId);

      expect(response.status).toBe(403);
    });
  });
});
