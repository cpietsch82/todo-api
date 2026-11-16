import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";
import { db } from "@/db";
import { users } from "@/db/schema";
import env from "../../../../env";
import TokenService, { REFRESH_TOKEN_REUSE_GRACE_MS, USED_REFRESH_TOKEN_RETENTION_MS } from "@modules/authentication/TokenService";
import { startRefreshTokenCleanup } from "@modules/authentication/refreshTokenCleanup";
import { logger } from "@/utils/logger";
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
  const getByToken = async (token: string) =>
    (await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hash(token))))[0];
  const markUsedAgo = (token: string, agoMs: number) =>
    db
      .update(refreshTokens)
      .set({ usedAt: new Date(Date.now() - agoMs) })
      .where(eq(refreshTokens.tokenHash, hash(token)));

  afterEach(() => {
    vi.restoreAllMocks();
  });

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
    it("should return a new token pair, mark the used token and keep the family", async () => {
      const token = await service.generateRefreshToken(testUser.userId);

      const { tokenPair, id } = await service.rotateRefreshToken(token);

      expect(id).toBe(testUser.userId);
      expect(tokenPair.accessToken).toBeTruthy();
      expect(tokenPair.refreshToken).not.toBe(token);

      const used = await getByToken(token);
      const next = await getByToken(tokenPair.refreshToken);
      expect(used.usedAt).not.toBeNull();
      expect(next.usedAt).toBeNull();
      expect(next.familyId).toBe(used.familyId);
    });

    it("should start a new family for every login", async () => {
      const first = await service.generateRefreshToken(testUser.userId);
      const second = await service.generateRefreshToken(testUser.userId);

      expect((await getByToken(first)).familyId).not.toBe((await getByToken(second)).familyId);
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
  // limit of tokens per user
  // ---------------------------------------------------------------------------
  describe("maximum number of tokens per user", () => {
    it("should keep only the newest tokens of a user and remove the oldest", async () => {
      const max = env.REFRESH_TOKEN_MAX_PER_USER;
      const tokens: string[] = [];
      for (let i = 0; i < max + 2; i++) tokens.push(await service.generateRefreshToken(testUser.userId));

      expect(await getStoredTokens(testUser.userId)).toHaveLength(max);
      expect(await getByToken(tokens[0])).toBeUndefined();
      expect(await getByToken(tokens[1])).toBeUndefined();
      expect(await getByToken(tokens[tokens.length - 1])).toBeDefined();
    });

    it("should not touch the tokens of other users", async () => {
      const otherUser = await generateUser();
      const otherToken = await service.generateRefreshToken(otherUser.userId);
      for (let i = 0; i < env.REFRESH_TOKEN_MAX_PER_USER + 2; i++) await service.generateRefreshToken(testUser.userId);

      expect(await getByToken(otherToken)).toBeDefined();
    });

    it("should not count used tokens and not remove the rotated one", async () => {
      const max = env.REFRESH_TOKEN_MAX_PER_USER;
      let token = await service.generateRefreshToken(testUser.userId);
      for (let i = 0; i < max + 3; i++) {
        token = (await service.rotateRefreshToken(token)).tokenPair.refreshToken;
      }

      // all rotated tokens are used and do not count, the current one is still there
      const stored = await getStoredTokens(testUser.userId);
      expect(stored.filter((row) => row.usedAt === null)).toHaveLength(1);
      expect((await getByToken(token)).usedAt).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // reuse detection
  // ---------------------------------------------------------------------------
  describe("reuse of a rotated token", () => {
    it("should only reject a reuse within the grace period and keep the session", async () => {
      const token = await service.generateRefreshToken(testUser.userId);
      const { tokenPair } = await service.rotateRefreshToken(token);

      await expect(service.rotateRefreshToken(token)).rejects.toThrow("REFRESH_TOKEN_INVALID");

      // the new token still works
      await expect(service.rotateRefreshToken(tokenPair.refreshToken)).resolves.toBeDefined();
    });

    it("should revoke the whole family when a rotated token is used after the grace period", async () => {
      const token = await service.generateRefreshToken(testUser.userId);
      const { tokenPair } = await service.rotateRefreshToken(token);
      const warn = vi.spyOn(logger, "warn");
      await markUsedAgo(token, REFRESH_TOKEN_REUSE_GRACE_MS + 1000);

      await expect(service.rotateRefreshToken(token)).rejects.toThrow("REFRESH_TOKEN_REUSED");

      // the token of the thief and the one of the real user are both gone
      expect(await getByToken(tokenPair.refreshToken)).toBeUndefined();
      expect(await getStoredTokens(testUser.userId)).toHaveLength(0);
      await expect(service.rotateRefreshToken(tokenPair.refreshToken)).rejects.toThrow("REFRESH_TOKEN_INVALID");
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ userId: testUser.userId }),
        expect.stringContaining("Reuse of a rotated refresh token"),
      );
    });

    it("should not revoke other logins of the same user or tokens of other users", async () => {
      const otherLogin = await service.generateRefreshToken(testUser.userId);
      const otherUser = await generateUser();
      const otherUserToken = await service.generateRefreshToken(otherUser.userId);
      const token = await service.generateRefreshToken(testUser.userId);
      await service.rotateRefreshToken(token);
      await markUsedAgo(token, REFRESH_TOKEN_REUSE_GRACE_MS + 1000);

      await expect(service.rotateRefreshToken(token)).rejects.toThrow("REFRESH_TOKEN_REUSED");

      expect(await getByToken(otherLogin)).toBeDefined();
      expect(await getByToken(otherUserToken)).toBeDefined();
    });

    it("should only report an expired token as expired", async () => {
      const token = await service.generateRefreshToken(testUser.userId);
      await service.rotateRefreshToken(token);
      await db
        .update(refreshTokens)
        .set({ expiresAt: new Date(Date.now() - 1000), usedAt: new Date(Date.now() - 60_000) })
        .where(eq(refreshTokens.tokenHash, hash(token)));

      await expect(service.rotateRefreshToken(token)).rejects.toThrow("REFRESH_TOKEN_EXPIRED");
    });
  });

  // ---------------------------------------------------------------------------
  // cleanup job
  // ---------------------------------------------------------------------------
  describe("cleanup", () => {
    it("should remove used tokens after the retention time", async () => {
      const oldUsed = await service.generateRefreshToken(testUser.userId);
      const recentUsed = await service.generateRefreshToken(testUser.userId);
      await markUsedAgo(oldUsed, USED_REFRESH_TOKEN_RETENTION_MS + 1000);
      await markUsedAgo(recentUsed, 1000);

      const removed = await service.deleteExpiredRefreshTokens();

      expect(removed).toBe(1);
      expect(await getByToken(oldUsed)).toBeUndefined();
      expect(await getByToken(recentUsed)).toBeDefined();
    });

    describe("startRefreshTokenCleanup", () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it("should clean up right away and then in the given interval until it is stopped", async () => {
        vi.useFakeTimers();
        const cleanup = vi.spyOn(TokenService.prototype, "deleteExpiredRefreshTokens").mockResolvedValue(0);

        const stop = startRefreshTokenCleanup(1000);
        await vi.advanceTimersByTimeAsync(0);
        expect(cleanup).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(2000);
        expect(cleanup).toHaveBeenCalledTimes(3);

        stop();
        await vi.advanceTimersByTimeAsync(5000);
        expect(cleanup).toHaveBeenCalledTimes(3);
      });

      it("should survive a failing cleanup and try again", async () => {
        vi.useFakeTimers();
        const cleanup = vi
          .spyOn(TokenService.prototype, "deleteExpiredRefreshTokens")
          .mockRejectedValueOnce(new Error("database down"))
          .mockResolvedValue(2);
        const error = vi.spyOn(logger, "error");

        const stop = startRefreshTokenCleanup(1000);
        await vi.advanceTimersByTimeAsync(1000);
        stop();

        expect(cleanup).toHaveBeenCalledTimes(2);
        expect(error).toHaveBeenCalledOnce();
      });
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
