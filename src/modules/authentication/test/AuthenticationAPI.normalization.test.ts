import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import bcrypt from "bcrypt";
import { eq } from "drizzle-orm";
import { AuthenticationAPI } from "../AuthenticationAPI";
import { getTestApp } from "@tests/integration.setup";
import { db } from "@/db";
import { users } from "@/db/schema";
import { updateUserSchema } from "@/modules/users/schema/user.schema";
import { loginSchema, registerSchema } from "../schema/authentication.schema";

const PAYLOAD = {
  email: "Max.Mustermann@Example.COM",
  username: "MaxMustermann",
  password: "securePassword123",
};

describe("Normalization of e-mail and username", () => {
  let server: Express;

  beforeAll(() => {
    new AuthenticationAPI();
    server = getTestApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("schemas", () => {
    it("should trim and lowercase the e-mail before validating it", () => {
      expect(loginSchema.parse({ email: "  Max@Example.COM ", password: "12345678" }).email).toBe("max@example.com");
      expect(registerSchema.parse({ ...PAYLOAD, email: " Max@Example.COM" }).email).toBe("max@example.com");
      expect(updateUserSchema.parse({ updates: { email: "Max@Example.COM " } }).updates.email).toBe("max@example.com");
    });

    it("should still reject an invalid e-mail", () => {
      expect(loginSchema.safeParse({ email: "  not-an-email ", password: "12345678" }).success).toBe(false);
    });
  });

  describe("POST /api/auth/register", () => {
    it("should store the e-mail in lowercase and keep the spelling of the username", async () => {
      const response = await request(server).post("/api/auth/register").send(PAYLOAD);

      expect(response.status).toBe(201);
      expect(response.body.user.email).toBe("max.mustermann@example.com");
      const [stored] = await db.select().from(users).where(eq(users.userId, response.body.user.userId));
      expect(stored.email).toBe("max.mustermann@example.com");
      expect(stored.username).toBe("MaxMustermann");
    });

    it("should reject the same e-mail in another spelling", async () => {
      await request(server).post("/api/auth/register").send(PAYLOAD);
      const response = await request(server)
        .post("/api/auth/register")
        .send({ ...PAYLOAD, email: " max.mustermann@example.com ", username: "someoneElse" });

      expect(response.status).toBe(409);
      expect(response.text).toBe("Email or username already in use");
    });

    it("should reject the same username in another spelling", async () => {
      await request(server).post("/api/auth/register").send(PAYLOAD);
      const response = await request(server)
        .post("/api/auth/register")
        .send({ ...PAYLOAD, email: "other@example.com", username: "maxmustermann" });

      expect(response.status).toBe(409);
      expect(response.text).toBe("Email or username already in use");
    });
  });

  describe("POST /api/auth/login", () => {
    it("should log in with the e-mail in any spelling", async () => {
      await request(server).post("/api/auth/register").send(PAYLOAD);
      const response = await request(server)
        .post("/api/auth/login")
        .send({ email: "  MAX.mustermann@example.com ", password: PAYLOAD.password });

      expect(response.status).toBe(201);
      expect(response.body.accessToken).toEqual(expect.any(String));
    });

    it("should compare against a password hash even when the e-mail is unknown (same timing)", async () => {
      const compare = vi.spyOn(bcrypt, "compare");

      const response = await request(server)
        .post("/api/auth/login")
        .send({ email: "nobody@example.com", password: PAYLOAD.password });

      expect(response.status).toBe(401);
      expect(response.text).toBe("Invalid credentials");
      expect(compare).toHaveBeenCalledTimes(1);
    });
  });

  describe("database constraints", () => {
    it("should refuse an e-mail with uppercase letters written past the service", async () => {
      await expect(
        db.insert(users).values({ email: "Upper@Example.com", username: "upper" }),
      ).rejects.toThrow();
    });

    it("should refuse a username that only differs in case written past the service", async () => {
      await db.insert(users).values({ email: "first@example.com", username: "SameName" });

      await expect(db.insert(users).values({ email: "second@example.com", username: "samename" })).rejects.toThrow();
    });
  });
});
