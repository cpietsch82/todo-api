import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import type { Todo, User } from "@/db/schema";
import { users } from "@/modules/users/schema/user.schema";
import {
  todoListMembers,
  todoLists,
  type TodoList,
} from "@modules/todo-lists/schema/todo-list.schema";
import { TodoAPI } from "@modules/todos/TodoAPI";
import { TodoCommentAPI } from "@modules/todos/TodoCommentAPI";
import {
  todoCommentMentions,
  todoComments,
} from "@modules/todos/schema/todo.comment.schema";
import { UserService } from "@modules/users/UserService";
import { resolveModule } from "@modules/core/resolveModule";
import {
  createAuthHeader,
  generateTodo,
  generateTodoComment,
  generateUser,
} from "@tests/test.helpers";
import { getTestServer } from "@tests/integration.setup";

describe("mentions in comment responses", () => {
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
    owner = await generateUser({ username: "olaf" });
    editor = await generateUser({ username: "edda" });
    viewer = await generateUser({ username: "vera" });
    [list] = await db
      .insert(todoLists)
      .values({ name: "Einkauf", ownerId: owner.userId })
      .returning();
    await db.insert(todoListMembers).values([
      { listId: list.listId, userId: editor.userId, role: "editor" },
      { listId: list.listId, userId: viewer.userId, role: "viewer" },
    ]);
    todo = await generateTodo(editor.userId, { listId: list.listId });
  });

  const get = async (user: User, path = "") =>
    request(server)
      .get(`/api/todos/${todo.todoId}/comments${path}`)
      .set(await createAuthHeader(user));

  const commentMentioning = async (
    author: User,
    mentioned: User[],
    extra: Partial<typeof todoComments.$inferInsert> = {},
  ) => {
    const comment = await generateTodoComment(todo.todoId, author.userId, {
      comment: mentioned.map((u) => `<@${u.userId}>`).join(" "),
      ...extra,
    });
    if (mentioned.length > 0) {
      await db
        .insert(todoCommentMentions)
        .values(
          mentioned.map((u) => ({
            commentId: comment.commentId,
            userId: u.userId,
          })),
        );
    }
    return comment;
  };

  it("should list the mentioned members of every comment on a page", async () => {
    await commentMentioning(owner, [viewer], {
      createdAt: new Date("2026-11-27T10:00:00Z"),
    });
    await commentMentioning(owner, [owner, editor], {
      createdAt: new Date("2026-11-27T10:01:00Z"),
    });

    const response = await get(viewer);

    expect(response.body.items[0].mentions).toEqual([
      { userId: viewer.userId, username: "vera" },
    ]);
    expect(response.body.items[1].mentions).toEqual([
      { userId: editor.userId, username: "edda" },
      { userId: owner.userId, username: "olaf" },
    ]);
    expect(response.body.items[1].mentions[0]).not.toHaveProperty("email");
  });

  it("should give a comment without mentions an empty list", async () => {
    await generateTodoComment(todo.todoId, owner.userId);
    expect((await get(viewer)).body.items[0].mentions).toEqual([]);
  });

  it("should show the current username after a rename", async () => {
    await commentMentioning(owner, [viewer]);
    await db
      .update(users)
      .set({ username: "veronika" })
      .where(eq(users.userId, viewer.userId));

    expect((await get(owner)).body.items[0].mentions[0].username).toBe(
      "veronika",
    );
  });

  it("should drop the mention of a deleted account and keep the comment", async () => {
    await commentMentioning(owner, [viewer]);
    await resolveModule(UserService).deleteUser(viewer.userId);

    const item = (await get(owner)).body.items[0];

    expect(item.mentions).toEqual([]);
    expect(item.comment).toContain("<@");
  });

  it("should give a placeholder no mentions", async () => {
    const parent = await commentMentioning(owner, [viewer], {
      deletedAt: new Date(),
      comment: null,
    });
    await generateTodoComment(todo.todoId, editor.userId, {
      parentCommentId: parent.commentId,
    });

    const item = (await get(owner)).body.items[0];

    expect(item).toMatchObject({ deleted: true, comment: null });
    expect(item.mentions).toEqual([]);
  });

  it("should include mentions in the replies page", async () => {
    const parent = await generateTodoComment(todo.todoId, owner.userId);
    await commentMentioning(editor, [viewer], {
      parentCommentId: parent.commentId,
    });

    const response = await request(server)
      .get(`/api/todo-comments/${parent.commentId}/replies`)
      .set(await createAuthHeader(owner));

    expect(response.status).toBe(200);
    expect(response.body.items[0].mentions).toEqual([
      { userId: viewer.userId, username: "vera" },
    ]);
  });
});
