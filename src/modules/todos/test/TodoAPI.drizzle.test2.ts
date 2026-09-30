import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { ExpressAPI } from "@modules/express/Express";
import type { Express } from "express";
import { TodoAPI } from "@modules/todos/TodoAPI";
import { InsertTodoSchema } from "@/modules/todos/schema/todo.schema";

describe("TodoAPI with drizzle-zod", () => {
  let api: ExpressAPI;
  let server: Express;

  beforeEach(() => {
    api = new ExpressAPI();
    new TodoAPI();
    server = api.getApp();
  });

  it("should validate with drizzle-zod schema", async () => {
    const validTodo = {
      title: "Test Todo",
      description: "Test Description",
      status: "in_progress",
      tags: ["test", "urgent"],
      userId: "550e8400-e29b-41d4-a716-446655440000",
    };

    // Schema Validierung im Test
    const result = InsertTodoSchema.safeParse(validTodo);
    expect(result.success).toBe(true);

    const response = await request(server).post("/api/todos").send(validTodo);

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      title: validTodo.title,
      status: validTodo.status,
      tags: validTodo.tags,
    });
  });

  it("should reject invalid data", async () => {
    const invalidTodo = {
      title: "ab", // Zu kurz
      tags: Array(11).fill("tag"), // Zu viele Tags
      userId: "invalid-uuid",
    };

    const response = await request(server).post("/api/todos").send(invalidTodo);

    expect(response.status).toBe(400);
    expect(response.body.status).toBe("error");
  });
});
