import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import type { Todo, User } from "@/db/schema";
import { users } from "@/modules/users/schema/user.schema";
import {
  todoListInvitations,
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

  describe("writing mentions", () => {
    let stranger: User;
    let invitee: User;

    beforeEach(async () => {
      stranger = await generateUser();
      invitee = await generateUser();
      // an open invitation is no membership
      await db.insert(todoListInvitations).values({
        listId: list.listId,
        inviteeId: invitee.userId,
        invitedBy: owner.userId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });
    });

    const post = async (
      user: User,
      commentRecord: { todoId: string; comment: string; parentCommentId?: string },
    ) =>
      request(server)
        .post("/api/todo-comments")
        .set(await createAuthHeader(user))
        .send({ commentRecord });

    const patch = async (user: User, commentId: string, comment: string) =>
      request(server)
        .patch(`/api/todo-comments/${commentId}`)
        .set(await createAuthHeader(user))
        .send({ updates: { comment } });

    const mentionRows = (commentId: string) =>
      db
        .select()
        .from(todoCommentMentions)
        .where(eq(todoCommentMentions.commentId, commentId));

    const countComments = async (todoId: string) =>
      (
        await db
          .select()
          .from(todoComments)
          .where(eq(todoComments.todoId, todoId))
      ).length;

    const removeFromList = (user: User) =>
      db
        .delete(todoListMembers)
        .where(
          and(
            eq(todoListMembers.listId, list.listId),
            eq(todoListMembers.userId, user.userId),
          ),
        );

    it("should store a mention of a member and of the list owner", async () => {
      const response = await post(viewer, {
        todoId: todo.todoId,
        comment: `Fragt <@${editor.userId}> oder <@${owner.userId}>`,
      });

      expect(response.status).toBe(201);
      expect(
        response.body.mentions.map((m: { userId: string }) => m.userId).sort(),
      ).toEqual([editor.userId, owner.userId].sort());
      expect(await mentionRows(response.body.commentId)).toHaveLength(2);
    });

    it("should store a person mentioned twice once", async () => {
      const response = await post(viewer, {
        todoId: todo.todoId,
        comment: `<@${editor.userId}> und nochmal <@${editor.userId}>`,
      });

      expect(response.status).toBe(201);
      expect(response.body.mentions).toEqual([
        { userId: editor.userId, username: "edda" },
      ]);
      expect(await mentionRows(response.body.commentId)).toHaveLength(1);
    });

    it.each([
      ["a stranger", () => stranger.userId],
      ["a person with an open invitation", () => invitee.userId],
    ])("should refuse a mention of %s and store nothing", async (_, id) => {
      const response = await post(viewer, {
        todoId: todo.todoId,
        comment: `Hallo <@${id()}>`,
      });

      expect(response.status).toBe(400);
      expect(response.text).toBe("Invalid mention");
      expect(await countComments(todo.todoId)).toBe(0);
    });

    it("should refuse a mention in a reply and store nothing", async () => {
      const parent = await generateTodoComment(todo.todoId, owner.userId);

      const response = await post(viewer, {
        todoId: todo.todoId,
        parentCommentId: parent.commentId,
        comment: `Hallo <@${stranger.userId}>`,
      });

      expect(response.status).toBe(400);
      expect(response.text).toBe("Invalid mention");
      expect(await countComments(todo.todoId)).toBe(1);
    });

    it("should refuse any mention on a todo without list", async () => {
      const ownTodo = await generateTodo(viewer.userId);

      const response = await post(viewer, {
        todoId: ownTodo.todoId,
        comment: `Notiz für <@${viewer.userId}>`,
      });

      expect(response.status).toBe(400);
      expect(response.text).toBe("Invalid mention");
      expect(await countComments(ownTodo.todoId)).toBe(0);
    });

    it("should keep broken tokens as plain text", async () => {
      const text = `<@123> und <@${editor.userId.toUpperCase()}>`;

      const response = await post(viewer, { todoId: todo.todoId, comment: text });

      expect(response.status).toBe(201);
      expect(response.body.comment).toBe(text);
      expect(response.body.mentions).toEqual([]);
      expect(await mentionRows(response.body.commentId)).toHaveLength(0);
    });

    it("should replace the mentions on an edit", async () => {
      const created = await post(viewer, {
        todoId: todo.todoId,
        comment: `Hallo <@${editor.userId}>`,
      });

      const response = await patch(
        viewer,
        created.body.commentId,
        `Hallo <@${owner.userId}>`,
      );

      expect(response.status).toBe(200);
      expect(response.body.mentions).toEqual([
        { userId: owner.userId, username: "olaf" },
      ]);
      expect(
        (await mentionRows(created.body.commentId)).map((row) => row.userId),
      ).toEqual([owner.userId]);
    });

    it("should refuse a new mention of a stranger on an edit", async () => {
      const created = await post(viewer, {
        todoId: todo.todoId,
        comment: `Hallo <@${editor.userId}>`,
      });

      const response = await patch(
        viewer,
        created.body.commentId,
        `Hallo <@${editor.userId}> und <@${stranger.userId}>`,
      );

      expect(response.status).toBe(400);
      expect(response.text).toBe("Invalid mention");
      expect(
        (await mentionRows(created.body.commentId)).map((row) => row.userId),
      ).toEqual([editor.userId]);
    });

    it("should allow fixing a typo next to a mention of a former member", async () => {
      const created = await post(editor, {
        todoId: todo.todoId,
        comment: `Danke <@${viewer.userId}>, erledgt`,
      });
      await removeFromList(viewer);

      const response = await patch(
        editor,
        created.body.commentId,
        `Danke <@${viewer.userId}>, erledigt`,
      );

      expect(response.status).toBe(200);
      expect(response.body.mentions).toEqual([
        { userId: viewer.userId, username: "vera" },
      ]);
    });

    it("should allow fixing a typo next to a mention of a deleted account", async () => {
      const created = await post(editor, {
        todoId: todo.todoId,
        comment: `Danke <@${viewer.userId}>, erledgt`,
      });
      await resolveModule(UserService).deleteUser(viewer.userId);

      const response = await patch(
        editor,
        created.body.commentId,
        `Danke <@${viewer.userId}>, erledigt`,
      );

      expect(response.status).toBe(200);
      expect(response.body.comment).toContain(`<@${viewer.userId}>`);
      expect(response.body.mentions).toEqual([]);
      expect(await mentionRows(created.body.commentId)).toHaveLength(0);
    });

    it("should refuse adding a former member on an edit", async () => {
      const created = await post(editor, {
        todoId: todo.todoId,
        comment: "Wer übernimmt?",
      });
      await removeFromList(viewer);

      const response = await patch(
        editor,
        created.body.commentId,
        `Wer übernimmt? <@${viewer.userId}>`,
      );

      expect(response.status).toBe(400);
      expect(response.text).toBe("Invalid mention");
      const [stored] = await db
        .select()
        .from(todoComments)
        .where(eq(todoComments.commentId, created.body.commentId));
      expect(stored.comment).toBe("Wer übernimmt?");
      expect(stored.updatedAt).toEqual(stored.createdAt);
    });

    it("should clear the mentions when the comment becomes a placeholder", async () => {
      const created = await post(editor, {
        todoId: todo.todoId,
        comment: `Hallo <@${viewer.userId}>`,
      });
      await generateTodoComment(todo.todoId, owner.userId, {
        parentCommentId: created.body.commentId,
      });
      expect(await mentionRows(created.body.commentId)).toHaveLength(1);

      const response = await request(server)
        .delete(`/api/todo-comments/${created.body.commentId}`)
        .set(await createAuthHeader(editor));

      expect(response.status).toBe(200);
      expect(response.body.mode).toBe("soft");
      expect(await mentionRows(created.body.commentId)).toHaveLength(0);
    });
  });
});
