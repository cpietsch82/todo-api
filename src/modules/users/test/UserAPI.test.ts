import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { UserAPI } from "@modules/users/UserAPI";
import UserService from "@modules/users/UserService";
import { User } from "@/db/schema";
import { createAuthHeader, generateTodo, generateTodoComment, generateUser, NON_EXISTENT_UUID } from "@tests/test.helpers";
import { getTestServer } from "@tests/integration.setup";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { TodoAPI } from "@modules/todos/TodoAPI";
import { TodoCommentAPI } from "@modules/todos/TodoCommentAPI";
import { todoComments } from "@modules/todos/schema/todo.comment.schema";
import { todoListMembers, todoLists } from "@modules/todo-lists/schema/todo-list.schema";

describe("UserAPI", () => {
  let server: Server;
  let testUser: User;

  beforeAll(async () => {
    new UserAPI();
    new TodoAPI();
    new TodoCommentAPI();
    server = getTestServer();
  });

  beforeEach(async () => {
    testUser = await generateUser();
  });

  // ---------------------------------------------------------------------------
  // GET /api/users
  // ---------------------------------------------------------------------------
  describe("GET /api/users", () => {
    it("should return the list containing the current user for an admin", async () => {
      const response = await request(server)
        .get("/api/users")
        .set(await createAuthHeader(testUser, { role: "admin" }));

      expect(response.status).toBe(200);
      expect(response.body).toBeInstanceOf(Array);
      expect(response.body).toHaveLength(1);
      expect(response.body[0].userId).toBe(testUser.userId);
    });

    it("should return all existing users for an admin", async () => {
      const authHeader = await createAuthHeader(testUser, { role: "admin" });

      await generateUser({ email: "second@test.com", username: "seconduser" });

      const response = await request(server)
        .get("/api/users")
        .set(authHeader);

      expect(response.status).toBe(200);
      expect(response.body).toBeInstanceOf(Array);
      expect(response.body).toHaveLength(2);
    });

    it("should return 403 for a normal user and not expose other users", async () => {
      await generateUser({ email: "second@test.com", username: "seconduser" });

      const response = await request(server)
        .get("/api/users")
        .set(await createAuthHeader(testUser));

      expect(response.status).toBe(403);
      expect(response.body).not.toBeInstanceOf(Array);
      expect(response.text).not.toContain("second@test.com");
    });

    it("should return 401 without a token", async () => {
      const response = await request(server).get("/api/users");

      expect(response.status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/users/:userId
  // ---------------------------------------------------------------------------
  describe("GET /api/users/:userId", () => {
    it("should return a specific user by id", async () => {
      const response = await request(server)
        .get(`/api/users/${testUser.userId}`)
        .set(await createAuthHeader(testUser));

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        userId: testUser.userId,
        email: testUser.email,
        username: testUser.username,
      });
      expect(response.body.password).toBeUndefined();
    });

    it("should return 404 for a non-existent user", async () => {
      const response = await request(server)
        .get(`/api/users/${NON_EXISTENT_UUID}`)
        .set(await createAuthHeader(testUser));

      expect(response.status).toBe(404);
    });

    it("should return 400 for an invalid userId (not a UUID)", async () => {
      const response = await request(server)
        .get("/api/users/not-a-valid-uuid")
        .set(await createAuthHeader(testUser));

      expect(response.status).toBe(400);
    });

    it("should return 403 when requesting another user", async () => {
      const otherUser = await generateUser({ email: "other@test.com", username: "otheruser" });

      const response = await request(server)
        .get(`/api/users/${otherUser.userId}`)
        .set(await createAuthHeader(testUser));

      expect(response.status).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH /api/users/:userId
  // ---------------------------------------------------------------------------
  describe("PATCH /api/users/:userId", () => {
    it("should update a user's firstName and lastName", async () => {
      const response = await request(server)
        .patch(`/api/users/${testUser.userId}`)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set(await createAuthHeader(testUser))
        .send({ updates: { firstName: "Max", lastName: "Mustermann" } });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        userId: testUser.userId,
        firstName: "Max",
        lastName: "Mustermann",
      });
    });

    it("should update only provided fields (partial update)", async () => {
      const response = await request(server)
        .patch(`/api/users/${testUser.userId}`)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set(await createAuthHeader(testUser))
        .send({ updates: { username: "updateduser" } });

      expect(response.status).toBe(200);
      expect(response.body.username).toBe("updateduser");
      expect(response.body.email).toBe(testUser.email);
    });

    it("should return 404 when updating a non-existent user", async () => {
      const response = await request(server)
        .patch(`/api/users/${NON_EXISTENT_UUID}`)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set(await createAuthHeader(testUser))
        .send({ updates: { firstName: "Ghost" } });

      expect(response.status).toBe(404);
    });

    it("should return 400 for an invalid email format in the update", async () => {
      const response = await request(server)
        .patch(`/api/users/${testUser.userId}`)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set(await createAuthHeader(testUser))
        .send({ updates: { email: "not-a-valid-email" } });

      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
    });

    it("should return 400 for an invalid userId (not a UUID)", async () => {
      const response = await request(server)
        .patch("/api/users/not-a-valid-uuid")
        .set("Content-Type", "application/json")
        .set(await createAuthHeader(testUser))
        .send({ updates: { firstName: "Max" } });

      expect(response.status).toBe(400);
    });

    it("should return 400 when the request body is missing the updates key", async () => {
      const response = await request(server)
        .patch(`/api/users/${testUser.userId}`)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set(await createAuthHeader(testUser))
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
    });

    it("should return 403 when updating another user", async () => {
      const otherUser = await generateUser({ email: "other2@test.com", username: "otheruser2" });

      const response = await request(server)
        .patch(`/api/users/${otherUser.userId}`)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set(await createAuthHeader(testUser))
        .send({ updates: { firstName: "Intruder" } });

      expect(response.status).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/users/:userId
  // ---------------------------------------------------------------------------
  describe("DELETE /api/users/:userId", () => {
    it("should answer 404 when the user was deleted by a concurrent request meanwhile", async () => {
      vi.spyOn(UserService.prototype, "deleteUser").mockResolvedValueOnce(undefined);

      const response = await request(server)
        .delete(`/api/users/${testUser.userId}`)
        .set(await createAuthHeader(testUser));

      expect(response.status).toBe(404);
      vi.restoreAllMocks();
    });

    it("should delete an existing user and return the deleted record", async () => {
      const authHeader = await createAuthHeader(testUser);

      const deleteResponse = await request(server)
        .delete(`/api/users/${testUser.userId}`)
        .set(authHeader);

      expect(deleteResponse.status).toBe(200);
      expect(deleteResponse.body.userId).toBe(testUser.userId);

      // verify the user is actually gone
      const getResponse = await request(server)
        .get(`/api/users/${testUser.userId}`)
        .set(authHeader);

      expect(getResponse.status).toBe(404);
    });

    it("should return 404 when deleting a non-existent user", async () => {
      const response = await request(server)
        .delete(`/api/users/${NON_EXISTENT_UUID}`)
        .set(await createAuthHeader(testUser));

      expect(response.status).toBe(404);
    });

    it("should return 400 for an invalid userId (not a UUID)", async () => {
      const response = await request(server)
        .delete("/api/users/not-a-valid-uuid")
        .set(await createAuthHeader(testUser));

      expect(response.status).toBe(400);
    });

    it("should return 403 when deleting another user", async () => {
      const otherUser = await generateUser({ email: "other3@test.com", username: "otheruser3" });

      const response = await request(server)
        .delete(`/api/users/${otherUser.userId}`)
        .set(await createAuthHeader(testUser));

      expect(response.status).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // deleting an account with comments
  // ---------------------------------------------------------------------------
  describe("deleting an account with comments", () => {
    let owner: User;
    let gone: User;
    let viewer: User;
    let todoId: string;

    const commentById = async (commentId: string) =>
      (await db.select().from(todoComments).where(eq(todoComments.commentId, commentId)))[0];

    const deleteAccount = async (user: User) =>
      request(server).delete(`/api/users/${user.userId}`).set(await createAuthHeader(user));

    beforeEach(async () => {
      owner = await generateUser({ email: "owner@test.com", username: "ownerx" });
      gone = await generateUser({ email: "gone@test.com", username: "gonex" });
      viewer = await generateUser({ email: "viewer@test.com", username: "viewerx" });
      const [list] = await db.insert(todoLists).values({ name: "Einkauf", ownerId: owner.userId }).returning();
      await db.insert(todoListMembers).values([
        { listId: list.listId, userId: gone.userId, role: "editor" },
        { listId: list.listId, userId: viewer.userId, role: "viewer" },
      ]);
      todoId = (await generateTodo(owner.userId, { listId: list.listId })).todoId;
    });

    it("should keep the replies of others as a placeholder without author when an account is deleted", async () => {
      const parent = await generateTodoComment(todoId, gone.userId);
      const reply = await generateTodoComment(todoId, viewer.userId, { parentCommentId: parent.commentId });

      const response = await deleteAccount(gone);

      expect(response.status).toBe(200);
      expect(await commentById(parent.commentId)).toMatchObject({ comment: null, userId: null, deletedAt: expect.any(Date) });
      expect(await commentById(reply.commentId)).toMatchObject({ comment: reply.comment });
    });

    it("should delete comments without replies of a deleted account completely, also on a todo of someone else", async () => {
      const own = await generateTodoComment(todoId, gone.userId);

      const response = await deleteAccount(gone);

      expect(response.status).toBe(200);
      expect(await commentById(own.commentId)).toBeUndefined();
    });

    const ROOT_ID = "00000000-0000-4000-8000-000000000001";
    const CHILD_ID = "00000000-0000-4000-8000-000000000002";

    it.each([
      ["root first", ROOT_ID, CHILD_ID],
      ["child first", CHILD_ID, ROOT_ID],
    ])("should remove a chain of own comments completely when the order by id is %s", async (_name, rootId, childId) => {
      await db.insert(todoComments).values([
        { commentId: rootId, todoId, userId: gone.userId, comment: "root" },
        { commentId: childId, todoId, userId: gone.userId, comment: "child", parentCommentId: rootId },
      ]);

      const response = await deleteAccount(gone);

      expect(response.status).toBe(200);
      expect(await commentById(rootId)).toBeUndefined();
      expect(await commentById(childId)).toBeUndefined();
    });

    it("should show the placeholder of a deleted account without author and let a moderator remove it as a thread", async () => {
      const parent = await generateTodoComment(todoId, gone.userId);
      await generateTodoComment(todoId, viewer.userId, { parentCommentId: parent.commentId });
      await deleteAccount(gone);

      const list = await request(server).get(`/api/todos/${todoId}/comments`).set(await createAuthHeader(owner));
      expect(list.status).toBe(200);
      expect(list.body.items[0]).toMatchObject({ deleted: true, comment: null, author: null });

      const removal = await request(server)
        .delete(`/api/todo-comments/${parent.commentId}?scope=branch`)
        .set(await createAuthHeader(owner));
      expect(removal.status).toBe(200);
      expect(removal.body).toMatchObject({ mode: "branch" });
    });
  });
});
