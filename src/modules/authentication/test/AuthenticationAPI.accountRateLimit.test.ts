import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import env from "../../../../env";
import { AuthenticationAPI } from "../AuthenticationAPI";
import { getTestApp } from "@tests/integration.setup";
import { db } from "@/db";
import { users, authentications } from "@/db/schema";
import { hashPassword } from "@/utils/passwords";

const PASSWORD = "securePassword123";

async function createUser(email: string, username: string) {
  const [user] = await db.insert(users).values({ email, username }).returning();
  await db.insert(authentications).values({ userId: user.userId, password: await hashPassword(PASSWORD) });
}

const login = (server: Express, email: string, password: string) =>
  request(server).post("/api/auth/login").send({ email, password });

describe("AuthAPI failed logins per account", () => {
  let server: Express;

  beforeAll(() => {
    // the limiters read the limits when the routes are created; the limit per IP stays high (vitest.config.ts)
    vi.spyOn(env, "LOGIN_ACCOUNT_RATE_LIMIT_MAX", "get").mockReturnValue(3);

    new AuthenticationAPI();
    server = getTestApp();
  });

  beforeEach(async () => {
    await createUser("alice@example.com", "alice");
    await createUser("bob@example.com", "bob");
  });

  it("should block an account after too many failed logins, whatever the spelling of the e-mail", async () => {
    expect((await login(server, "alice@example.com", "wrongPassword1")).status).toBe(401);
    expect((await login(server, "ALICE@example.com", "wrongPassword1")).status).toBe(401);
    expect((await login(server, " Alice@Example.com ", "wrongPassword1")).status).toBe(401);

    const blocked = await login(server, "alice@example.com", "wrongPassword1");
    const blockedCorrect = await login(server, "alice@example.com", PASSWORD);

    expect(blocked.status).toBe(429);
    expect(blocked.text).toBe("Too many login attempts, please try again later.");
    expect(blockedCorrect.status).toBe(429);
  });

  it("should not block other accounts", async () => {
    const other = await login(server, "bob@example.com", PASSWORD);

    expect(other.status).toBe(201);
  });

  it("should give unknown e-mails the same limit, so the block does not reveal which accounts exist", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await login(server, "nobody@example.com", "wrongPassword1")).status).toBe(401);
    }

    const blocked = await login(server, "nobody@example.com", "wrongPassword1");

    expect(blocked.status).toBe(429);
    expect(blocked.text).toBe("Too many login attempts, please try again later.");
  });
});
