import { BaseModule } from "../core/BaseModule";
import { JWTPayload, jwtVerify, SignJWT } from "jose";
import crypto from "node:crypto";
import env from "../../../env";
import UserService from "../users/UserService";
import { buildJwtClaims, type Permission } from "../authorization/permissions";
import AuthorizationService from "../authorization/AuthorizationService";
import { db } from "@/db";
import { eq, lt } from "drizzle-orm";
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

  async generateRefreshToken(id: string): Promise<string> {
    // Cryptographically random opaque token (not a JWT) – harder to forge,
    // easier to revoke without sharing secrets.
    const token = crypto.randomBytes(64).toString("hex");

    await db.insert(refreshTokens).values({
      userId: id,
      tokenHash: this.hashToken(token),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_MS),
    });

    return token;
  }

  async generateTokenPair(payload: JwtPayload) {
    return {
      accessToken: await this.generateAccessToken(payload),
      refreshToken: await this.generateRefreshToken(payload.id),
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
    // Invalidate the used token immediately (rotation – prevents replay attacks).
    // Delete and read happen in one statement, so a token can never be redeemed twice, even concurrently.
    const [stored] = await db
      .delete(refreshTokens)
      .where(eq(refreshTokens.tokenHash, this.hashToken(incomingToken)))
      .returning();

    if (!stored) {
      throw new Error("REFRESH_TOKEN_INVALID");
    }

    if (stored.expiresAt < new Date()) {
      throw new Error("REFRESH_TOKEN_EXPIRED");
    }

    const user = await this.userService.getUserById(stored.userId);
    if (!user) throw new Error("UNKNOWN_USER");
    const authorization = await this.authorizationService.getAuthorizationForUser(stored.userId);
    const tokenPair = await this.generateTokenPair(buildJwtClaims(user, authorization));

    return { tokenPair, id: stored.userId };
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
   * Removes all expired refresh tokens, e.g. to be called by a cleanup job.
   * @returns the number of removed tokens
   */
  async deleteExpiredRefreshTokens(): Promise<number> {
    const removed = await db
      .delete(refreshTokens)
      .where(lt(refreshTokens.expiresAt, new Date()))
      .returning({ refreshTokenId: refreshTokens.refreshTokenId });

    return removed.length;
  }
}

export default TokenService;
