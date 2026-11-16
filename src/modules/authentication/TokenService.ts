import { BaseModule } from "../core/BaseModule";
import { JWTPayload, jwtVerify, SignJWT } from "jose";
import crypto from "node:crypto";
import env from "../../../env";
import UserService from "../users/UserService";
import { buildJwtClaims, type Permission } from "../authorization/permissions";
import AuthorizationService from "../authorization/AuthorizationService";
import { db } from "@/db";
import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { refreshTokens } from "./schema/authentication.schema";

export interface JwtPayload extends JWTPayload {
  id: string;
  email: string;
  username: string;
  roles: string[];
  permissions: Permission[];
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

// A rotated token that is presented again within this time is treated as a parallel request of the same client
// (e.g. two tabs), not as theft.
export const REFRESH_TOKEN_REUSE_GRACE_MS = 10_000;
// Used tokens are kept this long to be able to detect their reuse, afterwards they are removed by the cleanup.
export const USED_REFRESH_TOKEN_RETENTION_MS = 24 * 60 * 60 * 1000;

class TokenService extends BaseModule {
  public static instance: TokenService;
  protected userService: UserService;
  protected authorizationService: AuthorizationService;

  constructor() {
    super("auth.token.service", "Business Logic for Token Management");

    if (!TokenService.instance) {
      TokenService.instance = this;
    }

    this.userService = new UserService();
    this.authorizationService = new AuthorizationService();

    return TokenService.instance;
  }

  // ---------------------------------------------------------------------------
  // Refresh tokens are persisted in the refresh_tokens table (only as sha256 hash)
  // ---------------------------------------------------------------------------
  private hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  async generateAccessToken(payload: JwtPayload): Promise<string> {
    const secret = env.ACCESS_TOKEN_SECRET;
    const secretKey = crypto.createSecretKey(secret, "utf-8");

    return new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(env.ACCESS_TOKEN_TTL || "7d")
      .sign(secretKey);
  }

  /**
   * Creates a new refresh token. Tokens which are created by a rotation pass the family id of the rotated token,
   * a login starts a new family. Only the newest REFRESH_TOKEN_MAX_PER_USER unused tokens of a user are kept.
   */
  async generateRefreshToken(id: string, familyId?: string): Promise<string> {
    // Cryptographically random opaque token (not a JWT) – harder to forge,
    // easier to revoke without sharing secrets.
    const token = crypto.randomBytes(64).toString("hex");

    await db.transaction(async (tx) => {
      await tx.insert(refreshTokens).values({
        userId: id,
        familyId,
        tokenHash: this.hashToken(token),
        expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_MS),
      });

      const surplus = await tx
        .select({ refreshTokenId: refreshTokens.refreshTokenId })
        .from(refreshTokens)
        .where(and(eq(refreshTokens.userId, id), isNull(refreshTokens.usedAt)))
        .orderBy(desc(refreshTokens.createdAt), desc(refreshTokens.refreshTokenId))
        .offset(env.REFRESH_TOKEN_MAX_PER_USER);

      if (surplus.length > 0) {
        await tx.delete(refreshTokens).where(
          inArray(
            refreshTokens.refreshTokenId,
            surplus.map((row) => row.refreshTokenId),
          ),
        );
      }
    });

    return token;
  }

  async generateTokenPair(payload: JwtPayload, familyId?: string) {
    return {
      accessToken: await this.generateAccessToken(payload),
      refreshToken: await this.generateRefreshToken(payload.id, familyId),
    };
  }

  // ---------------------------------------------------------------------------
  // Token validation
  // ---------------------------------------------------------------------------

  async verifyAccessToken(token: string): Promise<JwtPayload> {
    const secretKey = crypto.createSecretKey(env.ACCESS_TOKEN_SECRET, "utf-8");
    const { payload } = await jwtVerify(token, secretKey);

    return payload as JwtPayload;
  }

  async rotateRefreshToken(incomingToken: string): Promise<{ tokenPair: TokenPair; id: string }> {
    const tokenHash = this.hashToken(incomingToken);

    // Mark the token as used (rotation – prevents replay attacks). Claim and read happen in one statement,
    // so a token can never be redeemed twice, even concurrently.
    const [claimed] = await db
      .update(refreshTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.usedAt)))
      .returning();

    if (!claimed) {
      await this.handleUnclaimedToken(tokenHash);
    }

    if (claimed.expiresAt < new Date()) {
      await db.delete(refreshTokens).where(eq(refreshTokens.refreshTokenId, claimed.refreshTokenId));
      throw new Error("REFRESH_TOKEN_EXPIRED");
    }

    const user = await this.userService.getUserById(claimed.userId);
    if (!user) throw new Error("UNKNOWN_USER");
    const authorization = await this.authorizationService.getAuthorizationForUser(claimed.userId);
    const tokenPair = await this.generateTokenPair(buildJwtClaims(user, authorization), claimed.familyId);

    return { tokenPair, id: claimed.userId };
  }

  /**
   * Decides why a token could not be claimed: it is unknown, expired, or it was already used.
   * A token that is used again after the grace period was most likely stolen, so its whole family is revoked.
   * Always throws.
   */
  private async handleUnclaimedToken(tokenHash: string): Promise<never> {
    const [stored] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash)).limit(1);

    if (!stored) throw new Error("REFRESH_TOKEN_INVALID");
    if (stored.expiresAt < new Date()) throw new Error("REFRESH_TOKEN_EXPIRED");

    const usedAgoMs = stored.usedAt ? Date.now() - stored.usedAt.getTime() : Infinity;
    if (usedAgoMs <= REFRESH_TOKEN_REUSE_GRACE_MS) throw new Error("REFRESH_TOKEN_INVALID");

    await db.delete(refreshTokens).where(eq(refreshTokens.familyId, stored.familyId));
    this.logger.warn(
      { userId: stored.userId, familyId: stored.familyId },
      "Reuse of a rotated refresh token detected, all tokens of this login were revoked",
    );
    throw new Error("REFRESH_TOKEN_REUSED");
  }

  // ---------------------------------------------------------------------------
  // Revocation
  // ---------------------------------------------------------------------------

  async revokeRefreshToken(token: string): Promise<void> {
    await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, this.hashToken(token)));
  }

  async revokeAllRefreshTokensForUser(id: string): Promise<void> {
    await db.delete(refreshTokens).where(eq(refreshTokens.userId, id));
  }

  /**
   * Removes all expired refresh tokens and used ones which are older than the retention time,
   * e.g. to be called by a cleanup job.
   * @returns the number of removed tokens
   */
  async deleteExpiredRefreshTokens(): Promise<number> {
    const removed = await db
      .delete(refreshTokens)
      .where(
        or(
          lt(refreshTokens.expiresAt, new Date()),
          lt(refreshTokens.usedAt, new Date(Date.now() - USED_REFRESH_TOKEN_RETENTION_MS)),
        ),
      )
      .returning({ refreshTokenId: refreshTokens.refreshTokenId });

    return removed.length;
  }
}

export default TokenService;
