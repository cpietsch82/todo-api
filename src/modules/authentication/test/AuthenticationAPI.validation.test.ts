import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { AuthenticationAPI } from "../AuthenticationAPI";
import { getTestApp } from "@tests/integration.setup";
import { db } from "@/db";
import { authentications, roles, users } from "@/db/schema";
import { hashPassword } from "@/utils/passwords";
import { updateUserSchema } from "@/modules/users/schema/user.schema";
import { refreshSchema, registerSchema } from "../schema/authentication.schema";

const PAYLOAD = {
  email: "jane@example.com",
  username: "jane",
  password: "securePassword123",
  firstName: "Jane",
  lastName: "Doe",
};

const register = (server: Express, body: object) => request(server).post("/api/auth/register").send(body);

describe("Validation of the registration", () => {
  let server: Express;

  beforeAll(() => {
    new AuthenticationAPI();
    server = getTestApp();
  });

  describe("username", () => {
    it.each([
      ["Jürgen", "letters with umlauts"],
      ["François_92", "accents, digits and underscore"],
      ["max.mustermann-1", "dot and hyphen"],
      ["Straße", "sharp s"],
    ])("should accept %s (%s)", (username) => {
      expect(registerSchema.safeParse({ ...PAYLOAD, username }).success).toBe(true);
    });

    it.each([
      ["ab", "shorter than 3 characters"],
      ["a".repeat(51), "longer than 50 characters"],
      ["max mustermann", "space inside"],
      ["аdmin", "cyrillic а that looks like a latin a"],
      ["αlpha", "greek letter"],
      ["max​muster", "zero width space"],
      ["max<script>", "special characters"],
      ["   ", "only whitespace"],
    ])("should reject %j (%s)", (username) => {
      expect(registerSchema.safeParse({ ...PAYLOAD, username }).success).toBe(false);
    });

    it("should trim the username and unify its unicode form, so one name cannot exist twice", () => {
      const composed = "Jürgen"; // ü as one character
      const decomposed = "Jürgen"; // u + combining diaeresis, looks exactly the same

      expect(registerSchema.parse({ ...PAYLOAD, username: `  ${decomposed} ` }).username).toBe(composed);
    });

    it("should turn full width letters into normal ones", () => {
      expect(registerSchema.parse({ ...PAYLOAD, username: "ａｄｍｉｎ" }).username).toBe("admin");
    });
  });

  describe("first and last name", () => {
    it("should trim the names and turn an empty name into null", () => {
      const parsed = registerSchema.parse({ ...PAYLOAD, firstName: "  Jane ", lastName: "   " });

      expect(parsed.firstName).toBe("Jane");
      expect(parsed.lastName).toBeNull();
    });

    it("should allow any script in names", () => {
      expect(registerSchema.safeParse({ ...PAYLOAD, firstName: "Владимир", lastName: "O'Brien-Müller" }).success).toBe(true);
    });

    it("should reject control characters in names", () => {
      expect(registerSchema.safeParse({ ...PAYLOAD, firstName: "Ja\u0000ne" }).success).toBe(false);
      expect(registerSchema.safeParse({ ...PAYLOAD, lastName: "Doe‮" }).success).toBe(false);
    });
  });

  describe("password", () => {
    it("should accept a password of exactly 72 bytes", () => {
      expect(registerSchema.safeParse({ ...PAYLOAD, password: "a".repeat(72) }).success).toBe(true);
    });

    it("should reject a password longer than 72 bytes, counted in UTF-8", () => {
      expect(registerSchema.safeParse({ ...PAYLOAD, password: "a".repeat(73) }).success).toBe(false);
      // 37 umlauts are only 37 characters, but 74 bytes
      expect(registerSchema.safeParse({ ...PAYLOAD, password: "ü".repeat(37) }).success).toBe(false);
    });

    it("should still log in a user whose stored password is longer than 72 bytes", async () => {
      const longPassword = "a".repeat(100);
      const [user] = await db.insert(users).values({ email: "long@example.com", username: "long" }).returning();
      await db.insert(authentications).values({ userId: user.userId, password: await hashPassword(longPassword) });

      const response = await request(server).post("/api/auth/login").send({ email: "long@example.com", password: longPassword });

      expect(response.status).toBe(201);
    });
  });

  describe("too long values reach the api as 400, not as a database error (500)", () => {
    it.each([
      ["email", `${"a".repeat(250)}@example.com`],
      ["username", "a".repeat(51)],
      ["firstName", "a".repeat(51)],
      ["lastName", "a".repeat(51)],
    ])("should answer 400 for a too long %s", async (field, value) => {
      const response = await register(server, { ...PAYLOAD, [field]: value });

      expect(response.status).toBe(400);
      expect(response.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: field })]));
    });

    it("should apply the same rules to profile updates", () => {
      expect(updateUserSchema.safeParse({ updates: { firstName: "a".repeat(51) } }).success).toBe(false);
      expect(updateUserSchema.safeParse({ updates: { username: "аdmin" } }).success).toBe(false);
      expect(updateUserSchema.parse({ updates: { username: " Jürgen " } }).updates.username).toBe("Jürgen");
    });
  });

  describe("role assignment", () => {
    it("should not leave a user behind when the default role cannot be assigned", async () => {
      // simulates a database without the role "user" (e.g. a missing migration)
      await db.update(roles).set({ name: "user_hidden" }).where(eq(roles.name, "user"));
      try {
        const response = await register(server, PAYLOAD);

        expect(response.status).toBe(500);
        expect(await db.select().from(users).where(eq(users.email, PAYLOAD.email))).toHaveLength(0);
      } finally {
        await db.update(roles).set({ name: "user" }).where(eq(roles.name, "user_hidden"));
      }

      // once the problem is fixed, the same registration works
      expect((await register(server, PAYLOAD)).status).toBe(201);
    });
  });

  describe("refresh token", () => {
    it("should reject a refresh token that is longer than any token the api creates", () => {
      expect(refreshSchema.safeParse({ refreshToken: "a".repeat(128) }).success).toBe(true);
      expect(refreshSchema.safeParse({ refreshToken: "a".repeat(257) }).success).toBe(false);
    });
  });
});
