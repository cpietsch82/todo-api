import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import http, { type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db } from "@/db";
import type { Todo, User } from "@/db/schema";
import { todoListMembers, todoLists } from "@modules/todo-lists/schema/todo-list.schema";
import { TodoAPI } from "@modules/todos/TodoAPI";
import { TodoCommentAPI } from "@modules/todos/TodoCommentAPI";
import { CommentEventsService, MAX_COMMENT_STREAMS_PER_USER } from "@modules/todos/CommentEventsService";
import { createAuthHeader, generateTodo, generateUser, NON_EXISTENT_UUID } from "@tests/test.helpers";
import { getTestServer } from "@tests/integration.setup";
import { TodoService } from "@modules/todos/TodoService";
import { resolveModule } from "@modules/core/resolveModule";

interface OpenStream extends IncomingMessage {
  status: number;
  received: string;
}

describe("GET /api/todos/:todoId/comments/events", () => {
  const events = resolveModule(CommentEventsService);
  let server: Server;
  let owner: User;
  let viewer: User;
  let stranger: User;
  let todo: Todo;
  let open: OpenStream[] = [];

  /** opens the stream with a real connection and resolves as soon as the headers arrive */
  async function openStream(user: User | null, todoId: string, headers: Record<string, string> = {}): Promise<OpenStream> {
    const authHeader = user ? await createAuthHeader(user) : {};
    const { port } = server.address() as AddressInfo;
    return new Promise((resolve, reject) => {
      const req = http.get(
        { host: "127.0.0.1", port, path: `/api/todos/${todoId}/comments/events`, headers: { ...authHeader, ...headers } },
        (res) => {
          const stream = res as OpenStream;
          stream.status = res.statusCode!;
          stream.received = "";
          stream.setEncoding("utf8");
          stream.on("data", (chunk: string) => (stream.received += chunk));
          open.push(stream);
          resolve(stream);
        },
      );
      req.on("error", reject);
    });
  }

  /** the text received so far, once it contains the wanted text */
  const readUntil = (stream: OpenStream, text: string) =>
    vi.waitFor(() => {
      expect(stream.received).toContain(text);
      return stream.received;
    });

  beforeAll(() => {
    new TodoAPI();
    new TodoCommentAPI();
    server = getTestServer();
  });

  beforeEach(async () => {
    owner = await generateUser();
    viewer = await generateUser();
    stranger = await generateUser();
    const [list] = await db.insert(todoLists).values({ name: "Einkauf", ownerId: owner.userId }).returning();
    await db.insert(todoListMembers).values({ listId: list.listId, userId: viewer.userId, role: "viewer" });
    todo = await generateTodo(owner.userId, { listId: list.listId });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const stream of open) stream.destroy();
    open = [];
    events.closeAll();
    events.reopen();
  });

  it("should open a stream with the SSE headers and no compression", async () => {
    const stream = await openStream(viewer, todo.todoId, { "Accept-Encoding": "gzip" });

    expect(stream.status).toBe(200);
    expect(stream.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(stream.headers["x-accel-buffering"]).toBe("no");
    expect(stream.headers["cache-control"]).toBe("no-cache");
    expect(stream.headers["content-encoding"]).toBeUndefined();
    await readUntil(stream, ": connected");
  });

  it("should deliver a new comment written by someone else", async () => {
    const stream = await openStream(viewer, todo.todoId);
    await readUntil(stream, ": connected");

    await request(server)
      .post("/api/todo-comments")
      .set(await createAuthHeader(owner))
      .send({ commentRecord: { todoId: todo.todoId, comment: "Live" } })
      .expect(201);

    const text = await readUntil(stream, "event: comment.created");
    expect(text).toContain('"comment":"Live"');
  });

  it("should refuse a stranger with 403 and an unknown todo with 404", async () => {
    const forbidden = await request(server).get(`/api/todos/${todo.todoId}/comments/events`).set(await createAuthHeader(stranger));
    expect(forbidden.status).toBe(403);

    const missing = await request(server).get(`/api/todos/${NON_EXISTENT_UUID}/comments/events`).set(await createAuthHeader(owner));
    expect(missing.status).toBe(404);
    expect(events.countStreams()).toBe(0);
  });

  it("should refuse a request without token with 401", async () => {
    const response = await request(server).get(`/api/todos/${todo.todoId}/comments/events`);
    expect(response.status).toBe(401);
    expect(events.countStreams()).toBe(0);
  });

  it("should forget the stream when the client disconnects", async () => {
    const stream = await openStream(viewer, todo.todoId);
    await readUntil(stream, ": connected");
    expect(events.countStreams()).toBe(1);

    stream.destroy();

    await vi.waitFor(() => expect(events.countStreams()).toBe(0));
  });

  it("should end open streams on closeAll", async () => {
    const stream = await openStream(viewer, todo.todoId);
    await readUntil(stream, ": connected");
    const ended = new Promise<void>((resolve) => stream.on("end", resolve));

    events.closeAll();

    await ended;
    expect(events.countStreams()).toBe(0);
  });

  it("should not keep a stream whose client left while the access check was running", async () => {
    const todoService = resolveModule(TodoService);
    const original = todoService.getTodoById.bind(todoService);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(todoService, "getTodoById").mockImplementationOnce(async (id) => {
      await gate;
      return original(id);
    });
    const { port } = server.address() as AddressInfo;
    const authHeader = await createAuthHeader(viewer);
    const req = http.get({ host: "127.0.0.1", port, path: `/api/todos/${todo.todoId}/comments/events`, headers: authHeader });
    req.on("error", () => {});
    await vi.waitFor(() => expect(todoService.getTodoById).toHaveBeenCalled());

    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();

    await vi.waitFor(() => expect(events.countStreams()).toBe(0));
    // give the handler time to subscribe wrongly
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events.countStreams()).toBe(0);
  });

  it("should tell the evicted connection why it ended", async () => {
    const first = await openStream(viewer, todo.todoId);
    await readUntil(first, ": connected");
    const ended = new Promise<void>((resolve) => first.on("end", resolve));
    for (let i = 0; i < MAX_COMMENT_STREAMS_PER_USER; i++) {
      await readUntil(await openStream(viewer, todo.todoId), ": connected");
    }

    await ended;
    expect(first.received).toContain(": evicted\n\n");
  });
});
