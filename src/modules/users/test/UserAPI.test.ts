import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { UserAPI } from "@modules/users/UserAPI";
import { User } from "@/db/schema";
import { createAuthHeader, generateUser, NON_EXISTENT_UUID } from "@tests/test.helpers";
import { getTestApp } from "@tests/integration.setup";

describe("UserAPI", () => {
  let server: Express;
  let testUser: User;

  beforeAll(async () => {
    new UserAPI();
    server = getTestApp();
  });

  beforeEach(async () => {
    testUser = await generateUser();
  });

  // ---------------------------------------------------------------------------
  // GET /api/users
  // ---------------------------------------------------------------------------
  describe("GET /api/users", () => {
    it("should return the list containing the current user", async () => {
      const response = await request(server)
        .get("/api/users")
        .set(await createAuthHeader(testUser));

      expect(response.status).toBe(200);
      expect(response.body).toBeInstanceOf(Array);
      expect(response.body).toHaveLength(1);
      expect(response.body[0].userId).toBe(testUser.userId);
    });

    it("should return all existing users", async () => {
      const authHeader = await createAuthHeader(testUser);

      await generateUser({ email: "second@test.com", username: "seconduser" });

      const response = await request(server)
        .get("/api/users")
        .set(authHeader);

      expect(response.status).toBe(200);
      expect(response.body).toBeInstanceOf(Array);
      expect(response.body).toHaveLength(2);
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
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/users/:userId
  // ---------------------------------------------------------------------------
  describe("DELETE /api/users/:userId", () => {
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
  });
});
