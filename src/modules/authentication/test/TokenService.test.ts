import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";
import { db } from "@/db";
import { users } from "@/db/schema";
import TokenService from "@modules/authentication/TokenService";
import { refreshTokens } from "@modules/authentication/schema/authentication.schema";
import { generateUser } from "@tests/test.helpers";
// registers the database cleanup hooks (users are removed after each test)
import "@tests/integration.setup";
import type { User } from "@/db/schema";

const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

describe("TokenService refresh tokens", () => {
  const service = new TokenService();
  let testUser: User;

  const getStoredTokens = (userId: string) => db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId));

  beforeEach(async () => {
    testUser = await generateUser();
  });

  // ---------------------------------------------------------------------------
  // generateRefreshToken
  // ---------------------------------------------------------------------------
  describe("generateRefreshToken", () => {
    it("should persist only the hash of the token", async () => {
      const token = await service.generateRefreshToken(testUser.userId);

      const stored = await getStoredTokens(testUser.userId);
      expect(stored).toHaveLength(1);
      expect(stored[0].tokenHash).toBe(hash(token));
      expect(stored[0].tokenHash).not.toBe(token);
      expect(stored[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("should generate a unique token each time", async () => {
      const first = await service.generateRefreshToken(testUser.userId);
      const second = await service.generateRefreshToken(testUser.userId);

      expect(first).not.toBe(second);
      expect(await getStoredTokens(testUser.userId)).toHaveLength(2);
    });

    it("should fail for a non-existent user", async () => {
      await expect(service.generateRefreshToken("550e8400-e29b-41d4-a716-446655440000")).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // rotateRefreshToken
  // ---------------------------------------------------------------------------
  describe("rotateRefreshToken", () => {
    it("should return a new token pair and replace the used token", async () => {
      const token = await service.generateRefreshToken(testUser.userId);

      const { tokenPair, id } = await service.rotateRefreshToken(token);

      expect(id).toBe(testUser.userId);
      expect(tokenPair.accessToken).toBeTruthy();
      expect(tokenPair.refreshToken).not.toBe(token);

      const stored = await getStoredTokens(testUser.userId);
      expect(stored).toHaveLength(1);
      expect(stored[0].tokenHash).toBe(hash(tokenPair.refreshToken));
    });

    it("should reject a token that was already used", async () => {
      const token = await service.generateRefreshToken(testUser.userId);
      await service.rotateRefreshToken(token);

      await expect(service.rotateRefreshToken(token)).rejects.toThrow("REFRESH_TOKEN_INVALID");
    });

    it("should only let one of several concurrent requests redeem a token", async () => {
      const token = await service.generateRefreshToken(testUser.userId);

      const results = await Promise.allSettled([
        service.rotateRefreshToken(token),
        service.rotateRefreshToken(token),
        service.rotateRefreshToken(token),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    });

    it("should reject an unknown token", async () => {
      await expect(service.rotateRefreshToken("unknown-token")).rejects.toThrow("REFRESH_TOKEN_INVALID");
    });

    it("should reject and remove an expired token", async () => {
      const token = await service.generateRefreshToken(testUser.userId);
      await db
        .update(refreshTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(refreshTokens.tokenHash, hash(token)));

      await expect(service.rotateRefreshToken(token)).rejects.toThrow("REFRESH_TOKEN_EXPIRED");
      expect(await getStoredTokens(testUser.userId)).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // revocation
  // ---------------------------------------------------------------------------
  describe("revokeRefreshToken", () => {
    it("should revoke a token so it cannot be used anymore", async () => {
      const token = await service.generateRefreshToken(testUser.userId);

      await service.revokeRefreshToken(token);

      await expect(service.rotateRefreshToken(token)).rejects.toThrow("REFRESH_TOKEN_INVALID");
    });

    it("should not fail for an unknown token", async () => {
      await expect(service.revokeRefreshToken("unknown-token")).resolves.toBeUndefined();
    });
  });

  describe("revokeAllRefreshTokensForUser", () => {
    it("should only remove the tokens of the given user", async () => {
      const otherUser = await generateUser();
      await service.generateRefreshToken(testUser.userId);
      await service.generateRefreshToken(testUser.userId);
      await service.generateRefreshToken(otherUser.userId);

      await service.revokeAllRefreshTokensForUser(testUser.userId);

      expect(await getStoredTokens(testUser.userId)).toHaveLength(0);
      expect(await getStoredTokens(otherUser.userId)).toHaveLength(1);
    });
  });

  describe("deleteExpiredRefreshTokens", () => {
    it("should remove only expired tokens and return their count", async () => {
      const expired = await service.generateRefreshToken(testUser.userId);
      const valid = await service.generateRefreshToken(testUser.userId);
      await db
        .update(refreshTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(refreshTokens.tokenHash, hash(expired)));

      const removed = await service.deleteExpiredRefreshTokens();

      expect(removed).toBe(1);
      const stored = await getStoredTokens(testUser.userId);
      expect(stored).toHaveLength(1);
      expect(stored[0].tokenHash).toBe(hash(valid));
    });
  });

  // ---------------------------------------------------------------------------
  // cascade
  // ---------------------------------------------------------------------------
  it("should remove the tokens when the user is deleted", async () => {
    await service.generateRefreshToken(testUser.userId);

    await db.delete(users).where(eq(users.userId, testUser.userId));

    expect(await getStoredTokens(testUser.userId)).toHaveLength(0);
  });
});
