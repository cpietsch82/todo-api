import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { AuthAPI } from "../AuthAPI";
import { getTestApp } from "@tests/integration.setup";

const VALID_REGISTER_PAYLOAD = {
  email: "john.doe@example.com",
  username: "johndoe",
  password: "securePassword123",
  firstName: "John",
  lastName: "Doe",
};

describe("AuthAPI", () => {
  let server: Express;

  beforeAll(async () => {
    new AuthAPI();
    server = getTestApp();
  });

  // ---------------------------------------------------------------------------
  // POST /api/auth/register
  // ---------------------------------------------------------------------------
  describe("POST /api/auth/register", () => {
    it("should register a new user and return accessToken + refreshToken", async () => {
      const response = await request(server)
        .post("/api/auth/register")
        .set("Content-Type", "application/json")
        .send(VALID_REGISTER_PAYLOAD);

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        message: "User created",
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        user: {
          userId: expect.any(String),
          email: VALID_REGISTER_PAYLOAD.email,
          firstName: VALID_REGISTER_PAYLOAD.firstName,
          lastName: VALID_REGISTER_PAYLOAD.lastName,
        },
      });
      // password must never be returned
      expect(response.body.user.password).toBeUndefined();
    });

    it("should return 400 when email is missing", async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { email: _email, ...payload } = VALID_REGISTER_PAYLOAD;

      const response = await request(server)
        .post("/api/auth/register")
        .set("Content-Type", "application/json")
        .send(payload);

      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
    });

    it("should return 400 for an invalid email format", async () => {
      const response = await request(server)
        .post("/api/auth/register")
        .set("Content-Type", "application/json")
        .send({ ...VALID_REGISTER_PAYLOAD, email: "not-a-valid-email" });

      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
    });

    it("should return 400 when password is missing", async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { password: _password, ...payload } = VALID_REGISTER_PAYLOAD;

      const response = await request(server)
        .post("/api/auth/register")
        .set("Content-Type", "application/json")
        .send(payload);

      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
    });

    it("should return 400 when password is too short (< 8 chars)", async () => {
      const response = await request(server)
        .post("/api/auth/register")
        .set("Content-Type", "application/json")
        .send({ ...VALID_REGISTER_PAYLOAD, password: "short" });

      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
    });

    it("should return 400 when username is missing", async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { username: _username, ...payload } = VALID_REGISTER_PAYLOAD;

      const response = await request(server)
        .post("/api/auth/register")
        .set("Content-Type", "application/json")
        .send(payload);

      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
    });

    it("should return 409 or 500 when registering with a duplicate email", async () => {
      // first registration succeeds
      await request(server)
        .post("/api/auth/register")
        .set("Content-Type", "application/json")
        .send(VALID_REGISTER_PAYLOAD);

      // second registration with same email must fail
      const response = await request(server)
        .post("/api/auth/register")
        .set("Content-Type", "application/json")
        .send(VALID_REGISTER_PAYLOAD);

      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/auth/login
  // ---------------------------------------------------------------------------
  describe("POST /api/auth/login", () => {
    it("should return accessToken and refreshToken for valid credentials", async () => {
      // register first so the user exists
      await request(server)
        .post("/api/auth/register")
        .set("Content-Type", "application/json")
        .send(VALID_REGISTER_PAYLOAD);

      const response = await request(server)
        .post("/api/auth/login")
        .set("Content-Type", "application/json")
        .send({ email: VALID_REGISTER_PAYLOAD.email, password: VALID_REGISTER_PAYLOAD.password });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
      });
    });

    it("should return 400 when email is missing", async () => {
      const response = await request(server)
        .post("/api/auth/login")
        .set("Content-Type", "application/json")
        .send({ password: VALID_REGISTER_PAYLOAD.password });

      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
    });

    it("should return 400 for an invalid email format", async () => {
      const response = await request(server)
        .post("/api/auth/login")
        .set("Content-Type", "application/json")
        .send({ email: "not-an-email", password: VALID_REGISTER_PAYLOAD.password });

      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
    });

    it("should return 400 when password is missing", async () => {
      const response = await request(server)
        .post("/api/auth/login")
        .set("Content-Type", "application/json")
        .send({ email: VALID_REGISTER_PAYLOAD.email });

      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
    });

    it("should return 400 when password is too short (< 8 chars)", async () => {
      const response = await request(server)
        .post("/api/auth/login")
        .set("Content-Type", "application/json")
        .send({ email: VALID_REGISTER_PAYLOAD.email, password: "short" });

      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
    });

    it("should return an error for a non-existent email", async () => {
      const response = await request(server)
        .post("/api/auth/login")
        .set("Content-Type", "application/json")
        .send({ email: "ghost@example.com", password: "somePassword123" });

      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it("should return an error for a wrong password", async () => {
      await request(server)
        .post("/api/auth/register")
        .set("Content-Type", "application/json")
        .send(VALID_REGISTER_PAYLOAD);

      const response = await request(server)
        .post("/api/auth/login")
        .set("Content-Type", "application/json")
        .send({ email: VALID_REGISTER_PAYLOAD.email, password: "wrongPassword123" });

      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/auth/refresh
  // ---------------------------------------------------------------------------
  describe("POST /api/auth/refresh", () => {
    it("should return a new token pair for a valid refreshToken", async () => {
      const registerResponse = await request(server)
        .post("/api/auth/register")
        .set("Content-Type", "application/json")
        .send(VALID_REGISTER_PAYLOAD);

      const { refreshToken } = registerResponse.body;

      const response = await request(server)
        .post("/api/auth/refresh")
        .set("Content-Type", "application/json")
        .send({ refreshToken });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
      });
      // rotated token must differ from the original
      expect(response.body.refreshToken).not.toBe(refreshToken);
    });

    it("should invalidate the old refreshToken after rotation (replay attack prevention)", async () => {
      const registerResponse = await request(server)
        .post("/api/auth/register")
        .set("Content-Type", "application/json")
        .send(VALID_REGISTER_PAYLOAD);

      const { refreshToken } = registerResponse.body;

      // first  should succeeduse 
      await request(server)
        .post("/api/auth/refresh")
        .set("Content-Type", "application/json")
        .send({ refreshToken });

      // second use of the same  must be rejectedtoken 
      const replayResponse = await request(server)
        .post("/api/auth/refresh")
        .set("Content-Type", "application/json")
        .send({ refreshToken });

      expect(replayResponse.status).toBe(401);
    });

    it("should return 400 when refreshToken is missing from the body", async () => {
      const response = await request(server)
        .post("/api/auth/refresh")
        .set("Content-Type", "application/json")
        .send({});

      expect(response.status).toBe(400);
    });

    it("should return 401 for an invalid (unknown) refreshToken", async () => {
      const response = await request(server)
        .post("/api/auth/refresh")
        .set("Content-Type", "application/json")
        .send({ refreshToken: "this-is-not-a-valid-refresh-token" });

      expect(response.status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/auth/logout
  // ---------------------------------------------------------------------------
  describe("POST /api/auth/logout", () => {
    it("should logout successfully with a valid accessToken and refreshToken", async () => {
      const registerResponse = await request(server)
        .post("/api/auth/register")
        .set("Content-Type", "application/json")
        .send(VALID_REGISTER_PAYLOAD);

      const { accessToken, refreshToken } = registerResponse.body;

      const response = await request(server)
        .post("/api/auth/logout")
        .set("Authorization", `Bearer ${accessToken}`)
        .set("Content-Type", "application/json")
        .send({ refreshToken });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ message: "Logged out successfully" });
    });

    it("should revoke the refreshToken so it cannot be used after logout", async () => {
      const registerResponse = await request(server)
        .post("/api/auth/register")
        .set("Content-Type", "application/json")
        .send(VALID_REGISTER_PAYLOAD);

      const { accessToken, refreshToken } = registerResponse.body;

      await request(server)
        .post("/api/auth/logout")
        .set("Authorization", `Bearer ${accessToken}`)
        .set("Content-Type", "application/json")
        .send({ refreshToken });

      // trying to refresh with the now-revoked token must fail
      const refreshResponse = await request(server)
        .post("/api/auth/refresh")
        .set("Content-Type", "application/json")
        .send({ refreshToken });

      expect(refreshResponse.status).toBe(401);
    });

    it("should return 401 when no accessToken is provided", async () => {
      const registerResponse = await request(server)
        .post("/api/auth/register")
        .set("Content-Type", "application/json")
        .send(VALID_REGISTER_PAYLOAD);

      const { refreshToken } = registerResponse.body;

      const response = await request(server)
        .post("/api/auth/logout")
        .set("Content-Type", "application/json")
        .send({ refreshToken });

      expect(response.status).toBe(401);
    });

    it("should return 400 when refreshToken is missing from the body", async () => {
      const registerResponse = await request(server)
        .post("/api/auth/register")
        .set("Content-Type", "application/json")
        .send(VALID_REGISTER_PAYLOAD);

      const { accessToken } = registerResponse.body;

      const response = await request(server)
        .post("/api/auth/logout")
        .set("Authorization", `Bearer ${accessToken}`)
        .set("Content-Type", "application/json")
        .send({});

      expect(response.status).toBe(400);
    });
  });
});
