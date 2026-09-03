import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { TodoCommentAPI } from "@modules/todos/TodoCommentAPI";
import { TodoAPI } from "@modules/todos/TodoAPI";
import { User, Todo } from "@/db/schema";
import { createAuthHeader, generateTodo, generateTodoComment, generateUser, NON_EXISTENT_UUID } from "@tests/test.helpers";
import { getTestApp } from "@tests/integration.setup";

describe("TodoCommentAPI", () => {
  let server: Express;
  let testUser: User;
  let testTodo: Todo;

  beforeAll(async () => {
    new TodoAPI();
    new TodoCommentAPI();
    server = getTestApp();
  });

  beforeEach(async () => {
    testUser = await generateUser();
    testTodo = await generateTodo(testUser.userId);
  });

  // ---------------------------------------------------------------------------
  // GET /api/todo-comments
  // ---------------------------------------------------------------------------
  describe("GET /api/todo-comments", () => {
    it("should return an empty array when no comments exist", async () => {
      const response = await request(server)
        .get("/api/todo-comments")
        .set(await createAuthHeader(testUser));

      expect(response.status).toBe(200);
      expect(response.body).toBeInstanceOf(Array);
      expect(response.body).toHaveLength(0);
    });

    it("should return all existing comments", async () => {
      // create two comments first
      const authHeader = await createAuthHeader(testUser);
      await request(server)
        .post("/api/todo-comments")
        .set("Content-Type", "application/json")
        .set(authHeader)
        .send({ commentRecord: { todoId: testTodo.todoId, comment: "First comment" } });

      await request(server)
        .post("/api/todo-comments")
        .set("Content-Type", "application/json")
        .set(authHeader)
        .send({ commentRecord: { todoId: testTodo.todoId, comment: "Second comment" } });

      const response = await request(server)
        .get("/api/todo-comments")
        .set(authHeader);

      expect(response.status).toBe(200);
      expect(response.body).toBeInstanceOf(Array);
      expect(response.body).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/todo-comments
  // ---------------------------------------------------------------------------
  describe("POST /api/todo-comments", () => {
    it("should create a new comment for a valid todo", async () => {
      const newComment = {
        todoId: testTodo.todoId,
        comment: "This is a test comment",
      };

      const response = await request(server)
        .post("/api/todo-comments")
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set(await createAuthHeader(testUser))
        .send({ commentRecord: newComment });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        commentId: expect.any(String),
        todoId: testTodo.todoId,
        comment: newComment.comment,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
    });

    it("should reject a comment with an empty comment text", async () => {
      const response = await request(server)
        .post("/api/todo-comments")
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set(await createAuthHeader(testUser))
        .send({ commentRecord: { todoId: testTodo.todoId, comment: "" } });

      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
    });

    it("should reject a comment with a missing todoId", async () => {
      const response = await request(server)
        .post("/api/todo-comments")
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set(await createAuthHeader(testUser))
        .send({ commentRecord: { comment: "A comment without a todo" } });

      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
    });

    it("should reject a comment with an invalid todoId (not a UUID)", async () => {
      const response = await request(server)
        .post("/api/todo-comments")
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set(await createAuthHeader(testUser))
        .send({ commentRecord: { todoId: "not-a-valid-uuid", comment: "Valid comment text" } });

      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
    });

    it("should reject a request with a missing commentRecord body", async () => {
      const response = await request(server)
        .post("/api/todo-comments")
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set(await createAuthHeader(testUser))
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/todo-comments/:commentId
  // ---------------------------------------------------------------------------
  describe("GET /api/todo-comments/:commentId", () => {
    it("should return a specific comment by id", async () => {
      const authHeader = await createAuthHeader(testUser);

      const createResponse = await request(server)
        .post("/api/todo-comments")
        .set("Content-Type", "application/json")
        .set(authHeader)
        .send({ commentRecord: { todoId: testTodo.todoId, comment: "Findable comment" } });

      const { commentId } = createResponse.body;

      const response = await request(server)
        .get(`/api/todo-comments/${commentId}`)
        .set(authHeader);

      expect(response.status).toBe(200);
      expect(response.body.commentId).toBe(commentId);
      expect(response.body.comment).toBe("Findable comment");
    });

    it("should return 404 for a non-existent comment", async () => {
      const response = await request(server)
        .get(`/api/todo-comments/${NON_EXISTENT_UUID}`)
        .set(await createAuthHeader(testUser));

      expect(response.status).toBe(404);
    });

    it("should return 400 for an invalid commentId (not a UUID)", async () => {
      const response = await request(server)
        .get("/api/todo-comments/not-a-valid-uuid")
        .set(await createAuthHeader(testUser));

      expect(response.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH /api/todo-comments/:commentId
  // ---------------------------------------------------------------------------
  describe("PATCH /api/todo-comments/:commentId", () => {
    it("should update an existing comment", async () => {
      const authHeader = await createAuthHeader(testUser);
      const existing = await generateTodoComment(testTodo.todoId, testUser.userId, { comment: "Original comment" });

      const response = await request(server)
        .patch(`/api/todo-comments/${existing.commentId}`)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set(authHeader)
        .send({ updates: { comment: "Updated comment" } });

      expect(response.status).toBe(200);
      expect(response.body.commentId).toBe(existing.commentId);
      expect(response.body.comment).toBe("Updated comment");
    });

    it("should reject an update with an empty comment text", async () => {
      const authHeader = await createAuthHeader(testUser);
      const existing = await generateTodoComment(testTodo.todoId, testUser.userId);

      const response = await request(server)
        .patch(`/api/todo-comments/${existing.commentId}`)
        .set("Content-Type", "application/json")
        .set(authHeader)
        .send({ updates: { comment: "" } });

      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
    });

    it("should return 400 for an invalid commentId (not a UUID)", async () => {
      const response = await request(server)
        .patch("/api/todo-comments/not-a-valid-uuid")
        .set("Content-Type", "application/json")
        .set(await createAuthHeader(testUser))
        .send({ updates: { comment: "Some update" } });

      expect(response.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/todo-comments/:commentId
  // ---------------------------------------------------------------------------
  describe("DELETE /api/todo-comments/:commentId", () => {
    it("should delete an existing comment and return the deleted record", async () => {
      const authHeader = await createAuthHeader(testUser);
      const existing = await generateTodoComment(testTodo.todoId, testUser.userId, { comment: "Comment to delete" });

      const deleteResponse = await request(server)
        .delete(`/api/todo-comments/${existing.commentId}`)
        .set(authHeader);

      expect(deleteResponse.status).toBe(200);
      expect(deleteResponse.body.commentId).toBe(existing.commentId);

      // verify it is actually gone
      const getResponse = await request(server)
        .get(`/api/todo-comments/${existing.commentId}`)
        .set(authHeader);

      expect(getResponse.status).toBe(404);
    });

    it("should return 400 for an invalid commentId (not a UUID)", async () => {
      const response = await request(server)
        .delete("/api/todo-comments/not-a-valid-uuid")
        .set(await createAuthHeader(testUser));

      expect(response.status).toBe(400);
    });
  });
});
