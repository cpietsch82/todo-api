import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import env from "../../../../env";
import { AuthenticationAPI } from "../AuthenticationAPI";
import { getTestApp } from "@tests/integration.setup";
import { db } from "@/db";
import { users, authentications } from "@/db/schema";
import { hashPassword } from "@/utils/passwords";

const PAYLOAD = {
  email: "john.doe@example.com",
  username: "johndoe",
  password: "securePassword123",
};

describe("AuthAPI rate limits", () => {
  let server: Express;

  beforeAll(() => {
    // the limiters read the limits when the routes are created
    vi.spyOn(env, "LOGIN_RATE_LIMIT_MAX", "get").mockReturnValue(3);
    vi.spyOn(env, "REGISTER_RATE_LIMIT_MAX", "get").mockReturnValue(2);

    new AuthenticationAPI();
    server = getTestApp();
  });

  it("should limit registrations per IP", async () => {
    const first = await request(server).post("/api/auth/register").send(PAYLOAD);
    const second = await request(server).post("/api/auth/register").send(PAYLOAD); // 409, but counts as well
    const third = await request(server)
      .post("/api/auth/register")
      .send({ ...PAYLOAD, email: "other@example.com", username: "other" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(third.status).toBe(429);
    expect(third.text).toBe("Too many registrations from this IP, please try again later.");
  });

  it("should only count failed login attempts and then block further attempts", async () => {
    // the user is created directly, because the registrations of this IP are already used up
    const [user] = await db.insert(users).values({ email: PAYLOAD.email, username: PAYLOAD.username }).returning();
    await db.insert(authentications).values({ userId: user.userId, password: await hashPassword(PAYLOAD.password) });

    // successful logins do not count
    for (let i = 0; i < 4; i++) {
      const ok = await request(server).post("/api/auth/login").send({ email: PAYLOAD.email, password: PAYLOAD.password });
      expect(ok.status).toBe(201);
    }

    for (let i = 0; i < 3; i++) {
      const failed = await request(server).post("/api/auth/login").send({ email: PAYLOAD.email, password: "wrongPassword123" });
      expect(failed.status).toBe(401);
    }

    const blocked = await request(server).post("/api/auth/login").send({ email: PAYLOAD.email, password: "wrongPassword123" });
    const blockedCorrect = await request(server).post("/api/auth/login").send({ email: PAYLOAD.email, password: PAYLOAD.password });

    expect(blocked.status).toBe(429);
    expect(blocked.text).toBe("Too many login attempts, please try again later.");
    expect(blockedCorrect.status).toBe(429);
  });
});
