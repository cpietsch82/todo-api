import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { TodoAPI } from "@modules/todos/TodoAPI";
import { User } from "@/db/schema";
import type { Express } from "express";

import { createAuthHeader, generateTodo, generateUser, NON_EXISTENT_UUID } from "@tests/test.helpers";
import { getTestApp } from "@tests/integration.setup";

describe("TodoAPI", () => {
  let testUser: User;
  let server: Express;

  beforeAll(async () => {
    new TodoAPI();
    server = getTestApp();
  });

  beforeEach(async () => {
    testUser = await generateUser();
  });

  describe("GET /api/todos", () => {
    it("should return empty array initially", async () => {
      const response = await request(server)
        .get("/api/todos")
        .set(await createAuthHeader(testUser));

      expect(response.status).toBe(200);
      expect(response.body).instanceOf(Array);
      expect(response.body).toEqual([]);
    });

    it("should only return todos owned by the authenticated user", async () => {
      const otherUser = await generateUser();
      await generateTodo(testUser.userId, { title: "My Todo" });
      await generateTodo(otherUser.userId, { title: "Other Todo" });

      const response = await request(server)
        .get("/api/todos")
        .set(await createAuthHeader(testUser));

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0].userId).toBe(testUser.userId);
      expect(response.body[0].title).toBe("My Todo");
    });
  });

  describe("POST /api/todos", () => {
    it("should create a new todo", async () => {
      const newTodo = {
        title: "Test Todo",
        description: "Test Description",
        tags: ["test", "urgent"],
        status: "in_progress",
      };

      const response = await request(server)
        .post("/api/todos")
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set(await createAuthHeader(testUser))
        .send({ todoRecord: newTodo });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        todoId: expect.any(String),
        ...newTodo,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
    });

    it("should validate todo input with Zod", async () => {
      const invalidTodo = {
        title: "ab", // too short (min 3 chars)
        userId: 1,
      };
      const response = await request(server)
        .post("/api/todos")
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set(await createAuthHeader(testUser))
        .send(invalidTodo);
      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
      expect(response.body.message).toBe("Body validation error");
    });
  });

  describe("GET /api/todos/:id", () => {
    it("should return a specific todo", async () => {
      // create initial todo
      const createResponse = await request(server)
        .post("/api/todos")
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set(await createAuthHeader(testUser))
        .send({
          todoRecord: {
            title: "Test Todo",
            description: "Test",
            tags: [],
            status: "in_progress",
          },
        });
      const todoId = createResponse.body.todoId;

      const response = await request(server)
        .get(`/api/todos/${todoId}`)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set(await createAuthHeader(testUser));
      expect(response.status).toBe(200);
      expect(response.body.todoId).toBe(todoId);
    });

    it("should return 404 for non-existent todo", async () => {
      const response = await request(server)
        .get(`/api/todos/${NON_EXISTENT_UUID}`)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set(await createAuthHeader(testUser));
      expect(response.status).toBe(404);
    });

    it("should return 403 for a todo owned by another user", async () => {
      const otherUser = await generateUser();
      const foreignTodo = await generateTodo(otherUser.userId, { title: "Foreign Todo" });

      const response = await request(server)
        .get(`/api/todos/${foreignTodo.todoId}`)
        .set(await createAuthHeader(testUser));

      expect(response.status).toBe(403);
    });
  });

  describe("PATCH /api/todos/:todoId", () => {
    let todoId: string;

    beforeEach(async () => {
      const createResponse = await request(server)
        .post("/api/todos")
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set(await createAuthHeader(testUser))
        .send({
          todoRecord: {
            title: "Test Todo",
            description: "Test",
            tags: [],
            status: "in_progress",
          },
        });

      todoId = createResponse.body.todoId;
    });
    it("should update todo properly", async () => {
      // Toggle
      const successfulPatchResponse = await request(server)
        .patch(`/api/todos/${todoId}`)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set(await createAuthHeader(testUser))
        .send({
          updates: {
            status: "finished",
          }
        });

      expect(successfulPatchResponse.status).toBe(201);
      expect(successfulPatchResponse.body.status).toBe("finished");

      const invalidPatchResponse = await request(server)
        .patch(`/api/todos/${todoId}`)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set(await createAuthHeader(testUser))
        .send({
          updates: {
            status: "invalid_status",
          }
        });

      expect(invalidPatchResponse.status).toBe(400);
      expect(invalidPatchResponse.body.status).toBe("error");
      expect(invalidPatchResponse.body.message).toBe("Body validation error");
    });

    it("should return 400 for missing updates parameter", async () => {
      const response = await request(server)
        .patch(`/api/todos/${todoId}`)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set(await createAuthHeader(testUser))
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
      expect(response.body.message).toBe("Body validation error");
      expect(response.body.errors).toEqual([
        {
          path: 'updates',
          message: 'Invalid input: expected object, received undefined'
        }
      ]);
    });

    it("should return 400 for invalid updates parameter", async () => {
      const response = await request(server)
        .patch(`/api/todos/${todoId}`)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set(await createAuthHeader(testUser))
        .send({ updates: {
          status: "invalid_status",
        } });

      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
      expect(response.body.message).toBe("Body validation error");
      expect(response.body.errors).toEqual([
        {
          path: 'updates.status',
          message: 'Invalid option: expected one of "in_progress"|"finished"|"declined"|"not_ready"|"blocked_by"'
        }
      ]);
    });

    it("should return 403 when updating a todo owned by another user", async () => {
      const otherUser = await generateUser();
      const foreignTodo = await generateTodo(otherUser.userId, { title: "Foreign Todo" });

      const response = await request(server)
        .patch(`/api/todos/${foreignTodo.todoId}`)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set(await createAuthHeader(testUser))
        .send({
          updates: {
            status: "finished",
          },
        });

      expect(response.status).toBe(403);
    });
  });

  describe("DELETE /api/todos/:todoId", () => {
    it("should return 403 when deleting a todo owned by another user", async () => {
      const otherUser = await generateUser();
      const foreignTodo = await generateTodo(otherUser.userId, { title: "Foreign Todo" });

      const response = await request(server)
        .delete(`/api/todos/${foreignTodo.todoId}`)
        .set(await createAuthHeader(testUser));

      expect(response.status).toBe(403);
    });
  });
});
