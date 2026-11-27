import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import type { Todo, User } from "@/db/schema";
import { TodoAPI } from "@modules/todos/TodoAPI";
import { TodoCommentAPI } from "@modules/todos/TodoCommentAPI";
import { TodoCommentService } from "@modules/todos/TodoCommentService";
import { todoComments } from "@modules/todos/schema/todo.comment.schema";
import { resolveModule } from "@modules/core/resolveModule";
import { createAuthHeader, generateTodo, generateTodoComment, generateUser } from "@tests/test.helpers";
import { getTestServer } from "@tests/integration.setup";

/**
 * The comment of a write is read back inside its transaction: when that read fails, the write is rolled back, so a
 * 500 never stands for a comment that was stored anyway (a retry of the client would duplicate it).
 */
describe("TodoCommentAPI – reading the written comment back", () => {
  let server: Server;
  let author: User;
  let todo: Todo;

  beforeAll(() => {
    new TodoAPI();
    new TodoCommentAPI();
    server = getTestServer();
  });

  beforeEach(async () => {
    author = await generateUser();
    todo = await generateTodo(author.userId);
  });

  afterEach(() => vi.restoreAllMocks());

  const failReadBack = () => {
    vi.spyOn(resolveModule(TodoCommentService), "getDiscussionComment").mockRejectedValue(new Error("db gone"));
    vi.spyOn(console, "error").mockImplementation(() => {});
  };

  it("should not keep a new comment when reading it back fails", async () => {
    failReadBack();

    const response = await request(server)
      .post("/api/todo-comments")
      .set("Content-Type", "application/json")
      .set(await createAuthHeader(author))
      .send({ commentRecord: { todoId: todo.todoId, comment: "Hallo" } });

    expect(response.status).toBe(500);
    const stored = await db.select().from(todoComments).where(eq(todoComments.todoId, todo.todoId));
    expect(stored).toEqual([]);
  });

  it("should keep the old text when reading an edit back fails", async () => {
    const existing = await generateTodoComment(todo.todoId, author.userId, { comment: "Alt" });
    failReadBack();

    const response = await request(server)
      .patch(`/api/todo-comments/${existing.commentId}`)
      .set("Content-Type", "application/json")
      .set(await createAuthHeader(author))
      .send({ updates: { comment: "Neu" } });

    expect(response.status).toBe(500);
    const [stored] = await db.select().from(todoComments).where(eq(todoComments.commentId, existing.commentId));
    expect(stored.comment).toBe("Alt");
  });
});
