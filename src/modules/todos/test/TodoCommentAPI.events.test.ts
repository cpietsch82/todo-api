import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { db } from "@/db";
import type { Todo, User } from "@/db/schema";
import { todoListMembers, todoLists } from "@modules/todo-lists/schema/todo-list.schema";
import { TodoAPI } from "@modules/todos/TodoAPI";
import { TodoCommentAPI } from "@modules/todos/TodoCommentAPI";
import { todoComments } from "@modules/todos/schema/todo.comment.schema";
import { CommentEventsService, type CommentStream } from "@modules/todos/CommentEventsService";
import { createAuthHeader, generateTodo, generateTodoComment, generateUser, NON_EXISTENT_UUID } from "@tests/test.helpers";
import { getTestServer } from "@tests/integration.setup";
import { resolveModule } from "@modules/core/resolveModule";

interface FakeStream extends CommentStream {
  sent: { event: string; data: unknown }[];
}

function fakeStream(user: User): FakeStream {
  const stream: FakeStream = {
    user: { id: user.userId },
    expiresAt: Date.now() + 60_000,
    sent: [],
    send(event, data) {
      stream.sent.push({ event, data });
    },
    ping() {},
    close() {},
  };
  return stream;
}

/** what a client would receive: dates as text */
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("Live events for comment changes", () => {
  const events = resolveModule(CommentEventsService);
  let server: Server;
  let owner: User;
  let viewer: User;
  let todo: Todo;
  let stream: FakeStream;

  beforeAll(() => {
    new TodoAPI();
    new TodoCommentAPI();
    server = getTestServer();
  });

  beforeEach(async () => {
    owner = await generateUser();
    viewer = await generateUser({ username: "vera" });
    const [list] = await db.insert(todoLists).values({ name: "Einkauf", ownerId: owner.userId }).returning();
    await db.insert(todoListMembers).values({ listId: list.listId, userId: viewer.userId, role: "viewer" });
    todo = await generateTodo(owner.userId, { listId: list.listId });
    stream = fakeStream(owner);
    events.subscribe(todo.todoId, stream);
  });

  afterEach(() => events.closeAll());

  const post = async (user: User, commentRecord: { todoId: string; comment: string; parentCommentId?: string }) =>
    request(server)
      .post("/api/todo-comments")
      .set(await createAuthHeader(user))
      .send({ commentRecord });

  const patch = async (user: User, commentId: string, comment: string) =>
    request(server)
      .patch(`/api/todo-comments/${commentId}`)
      .set(await createAuthHeader(user))
      .send({ updates: { comment } });

  const remove = async (user: User, commentId: string, query = "") =>
    request(server)
      .delete(`/api/todo-comments/${commentId}${query}`)
      .set(await createAuthHeader(user));

  const placeholder = async (extra: object = {}) =>
    (
      await db
        .insert(todoComments)
        .values({ todoId: todo.todoId, userId: null, comment: null, deletedAt: new Date(), ...extra })
        .returning()
    )[0];

  it("should announce a new top-level comment without parentReplyCount", async () => {
    const response = await post(viewer, { todoId: todo.todoId, comment: "Hallo" });

    expect(response.status).toBe(201);
    expect(wire(stream.sent)).toEqual([{ event: "comment.created", data: { comment: response.body } }]);
  });

  it("should announce a reply with the new reply count of its parent", async () => {
    const parent = await generateTodoComment(todo.todoId, owner.userId);
    await post(viewer, { todoId: todo.todoId, comment: "Eins", parentCommentId: parent.commentId });
    const second = await post(viewer, { todoId: todo.todoId, comment: "Zwei", parentCommentId: parent.commentId });

    expect(stream.sent).toHaveLength(2);
    expect(wire(stream.sent[1])).toEqual({
      event: "comment.created",
      data: { comment: second.body, parentReplyCount: 2 },
    });
  });

  it("should announce an edit, but not an unchanged one", async () => {
    const comment = await generateTodoComment(todo.todoId, viewer.userId);

    const changed = await patch(viewer, comment.commentId, "Neuer Text");
    expect(stream.sent).toHaveLength(1);
    expect(wire(stream.sent[0])).toEqual({ event: "comment.updated", data: { comment: changed.body } });

    const same = await patch(viewer, comment.commentId, "Neuer Text");
    expect(same.status).toBe(200);
    expect(stream.sent).toHaveLength(1);
  });

  it("should announce nothing when writing fails", async () => {
    const invalidMention = await post(viewer, { todoId: todo.todoId, comment: `<@${NON_EXISTENT_UUID}>` });
    const invalidParent = await post(viewer, {
      todoId: todo.todoId,
      comment: "Antwort",
      parentCommentId: NON_EXISTENT_UUID,
    });

    expect(invalidMention.status).toBe(400);
    expect(invalidParent.status).toBe(400);
    expect(stream.sent).toEqual([]);
  });

  it("should announce a placeholder as soft", async () => {
    const parent = await generateTodoComment(todo.todoId, owner.userId);
    await generateTodoComment(todo.todoId, viewer.userId, { parentCommentId: parent.commentId });

    const response = await remove(owner, parent.commentId);

    expect(response.status).toBe(200);
    expect(stream.sent).toEqual([
      { event: "comment.deleted", data: { commentId: parent.commentId, parentCommentId: null, mode: "soft" } },
    ]);
  });

  it("should announce a deleted reply and every emptied placeholder above it", async () => {
    const parent = await placeholder();
    const reply = await generateTodoComment(todo.todoId, viewer.userId, { parentCommentId: parent.commentId });

    const response = await remove(viewer, reply.commentId);

    expect(response.status).toBe(200);
    expect(stream.sent.map((e) => e.data)).toEqual([
      { commentId: reply.commentId, parentCommentId: parent.commentId, mode: "hard", parentReplyCount: 0 },
      { commentId: parent.commentId, parentCommentId: null, mode: "hard" },
    ]);
  });

  it("should announce a removed thread once, not per reply", async () => {
    const root = await generateTodoComment(todo.todoId, owner.userId);
    const middle = await generateTodoComment(todo.todoId, viewer.userId, { parentCommentId: root.commentId });
    await generateTodoComment(todo.todoId, viewer.userId, { parentCommentId: middle.commentId });

    const response = await remove(owner, middle.commentId, "?scope=branch");

    expect(response.status).toBe(200);
    expect(stream.sent).toEqual([
      {
        event: "comment.deleted",
        data: { commentId: middle.commentId, parentCommentId: root.commentId, mode: "branch", parentReplyCount: 0 },
      },
    ]);
  });
});
