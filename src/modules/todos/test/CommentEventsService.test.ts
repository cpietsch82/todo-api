import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import type { Todo, User } from "@/db/schema";
import { todoListMembers, todoLists, type MemberRole } from "@modules/todo-lists/schema/todo-list.schema";
import { todos } from "@modules/todos/schema/todo.schema";
import { CommentEventsService, type CommentEvent, type CommentStream } from "@modules/todos/CommentEventsService";
import { generateTodo, generateUser } from "@tests/test.helpers";
import { resolveModule } from "@modules/core/resolveModule";

interface FakeStream extends CommentStream {
  sent: { event: string; data: unknown }[];
  pings: number;
  closed: boolean;
  closes: number;
  reasons: (string | undefined)[];
}

function fakeStream(user: User, options: { expiresAt?: number; throwOnSend?: boolean } = {}): FakeStream {
  const stream: FakeStream = {
    user: { id: user.userId },
    expiresAt: options.expiresAt ?? Date.now() + 60_000,
    sent: [],
    pings: 0,
    closed: false,
    closes: 0,
    reasons: [],
    send(event, data) {
      if (options.throwOnSend) throw new Error("socket gone");
      stream.sent.push({ event, data });
    },
    ping() {
      stream.pings++;
    },
    close(reason) {
      stream.reasons.push(reason);
      stream.closes++;
      stream.closed = true;
    },
  };
  return stream;
}

const event: CommentEvent = {
  name: "comment.deleted",
  data: { commentId: "c1", parentCommentId: null, mode: "hard" },
};

async function createListWith(ownerId: string, members: { user: User; role: MemberRole }[]) {
  const [list] = await db.insert(todoLists).values({ name: "Einkauf", ownerId }).returning();
  for (const { user, role } of members) {
    await db.insert(todoListMembers).values({ listId: list.listId, userId: user.userId, role });
  }
  return list;
}

describe("CommentEventsService", () => {
  const service = resolveModule(CommentEventsService);
  let owner: User;
  let todo: Todo;

  beforeEach(async () => {
    owner = await generateUser();
    todo = await generateTodo(owner.userId);
  });

  afterEach(() => {
    service.closeAll();
    service.reopen();
  });

  it("should send an event only to the streams of that todo", async () => {
    const otherTodo = await generateTodo(owner.userId);
    const a = fakeStream(owner);
    const b = fakeStream(owner);
    service.subscribe(todo.todoId, a);
    service.subscribe(otherTodo.todoId, b);

    await service.publish(todo.todoId, event);

    expect(a.sent).toEqual([{ event: "comment.deleted", data: event.data }]);
    expect(b.sent).toEqual([]);
  });

  it("should close a stream whose user lost access before sending", async () => {
    const viewer = await generateUser();
    const list = await createListWith(owner.userId, [{ user: viewer, role: "viewer" }]);
    const listTodo = await generateTodo(owner.userId, { listId: list.listId });
    const stream = fakeStream(viewer);
    service.subscribe(listTodo.todoId, stream);
    await db
      .delete(todoListMembers)
      .where(and(eq(todoListMembers.listId, list.listId), eq(todoListMembers.userId, viewer.userId)));

    await service.publish(listTodo.todoId, event);

    expect(stream.sent).toEqual([]);
    expect(stream.closed).toBe(true);
    expect(service.countStreams()).toBe(0);
  });

  it("should close the streams of a deleted todo", async () => {
    const stream = fakeStream(owner);
    service.subscribe(todo.todoId, stream);
    await db.delete(todos).where(eq(todos.todoId, todo.todoId));

    await service.publish(todo.todoId, event);

    expect(stream.closed).toBe(true);
    expect(stream.sent).toEqual([]);
    expect(service.countStreams()).toBe(0);
  });

  it("should close an expired stream on the heartbeat and ping the others", async () => {
    const expired = fakeStream(owner, { expiresAt: Date.now() - 1 });
    const alive = fakeStream(owner);
    service.subscribe(todo.todoId, expired);
    service.subscribe(todo.todoId, alive);

    await service.heartbeat();

    expect(expired.closed).toBe(true);
    expect(expired.pings).toBe(0);
    expect(alive.pings).toBe(1);
    expect(alive.closed).toBe(false);
    expect(service.countStreams()).toBe(1);
  });

  it("should close the oldest stream of a user when a sixth one comes", () => {
    const streams = Array.from({ length: 6 }, () => fakeStream(owner));
    streams.forEach((stream) => service.subscribe(todo.todoId, stream));

    expect(streams[0].closed).toBe(true);
    expect(streams.slice(1).every((stream) => !stream.closed)).toBe(true);
    expect(service.countStreams()).toBe(5);
  });

  it("should tell only the evicted stream why it was closed", () => {
    const streams = Array.from({ length: 6 }, () => fakeStream(owner));
    streams.forEach((stream) => service.subscribe(todo.todoId, stream));

    expect(streams[0].reasons).toEqual(["evicted"]);
    service.closeAll();
    expect(streams.slice(1).every((stream) => stream.reasons[0] === undefined)).toBe(true);
  });

  it("should know whether anybody listens to a todo", () => {
    expect(service.hasStreams(todo.todoId)).toBe(false);
    const unsubscribe = service.subscribe(todo.todoId, fakeStream(owner));
    expect(service.hasStreams(todo.todoId)).toBe(true);
    unsubscribe();
    expect(service.hasStreams(todo.todoId)).toBe(false);
  });

  it("should close a stream that subscribes after closeAll right away", () => {
    service.closeAll();
    const late = fakeStream(owner);

    const unsubscribe = service.subscribe(todo.todoId, late);

    expect(late.closes).toBe(1);
    expect(service.countStreams()).toBe(0);
    expect(() => unsubscribe()).not.toThrow();
  });

  it("should forget a stream after unsubscribe and not write to it again", async () => {
    const stream = fakeStream(owner);
    const unsubscribe = service.subscribe(todo.todoId, stream);

    unsubscribe();
    await service.publish(todo.todoId, event);

    expect(stream.sent).toEqual([]);
    expect(() => unsubscribe()).not.toThrow();
    expect(service.countStreams()).toBe(0);
  });

  it("should keep serving the others when sending to one stream throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = fakeStream(owner, { throwOnSend: true });
    const healthy = fakeStream(owner);
    service.subscribe(todo.todoId, broken);
    service.subscribe(todo.todoId, healthy);

    await service.publish(todo.todoId, event);

    expect(broken.closed).toBe(true);
    expect(healthy.sent).toHaveLength(1);
    expect(healthy.closed).toBe(false);
    expect(service.countStreams()).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("should close every stream on closeAll", () => {
    const streams = [fakeStream(owner), fakeStream(owner), fakeStream(owner)];
    streams.forEach((stream) => service.subscribe(todo.todoId, stream));

    service.closeAll();

    expect(streams.every((stream) => stream.closed)).toBe(true);
    expect(service.countStreams()).toBe(0);
  });

  it("should close a stream once when it is evicted while a publish is in flight", async () => {
    const streams = Array.from({ length: 5 }, () => fakeStream(owner, { expiresAt: Date.now() - 1 }));
    streams.forEach((stream) => service.subscribe(todo.todoId, stream));

    const publishing = service.publish(todo.todoId, event);
    service.subscribe(todo.todoId, fakeStream(owner)); // evicts streams[0] while the todo loads
    await publishing;

    expect(streams[0].closes).toBe(1);
  });

  it("should not reject and keep the streams open when loading the todo fails", async () => {
    const stream = fakeStream(owner);
    service.subscribe(todo.todoId, stream);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const load = vi.spyOn(service["todoService"], "getTodoById").mockRejectedValueOnce(new Error("db down"));

    await expect(service.publish(todo.todoId, event)).resolves.toBeUndefined();

    expect(stream.sent).toEqual([]);
    expect(stream.closed).toBe(false);
    expect(service.countStreams()).toBe(1);
    expect(error).toHaveBeenCalled();
    load.mockRestore();
    error.mockRestore();
  });
});
