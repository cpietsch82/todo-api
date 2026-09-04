import { BaseModule } from "../core/BaseModule";
import { JWTPayload, jwtVerify, SignJWT } from "jose";
import crypto from "node:crypto";
import env from "../../../env";
import UserService from "../users/UserService";
import { buildJwtClaims, type Permission } from "../authorization/permissions";
import AuthorizationService from "../authorization/AuthorizationService";

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

export interface StoredRefreshToken {
  token: string;
  id: string; // could be replaced with userId or another unique property of the JwtPayload
  expiresAt: Date;
  createdAt: Date;
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
  // In-memory store – replace with Firestore / Redis in production
  // ---------------------------------------------------------------------------
  public refreshTokenStore = new Map<string, StoredRefreshToken>();

  async generateAccessToken(payload: JwtPayload): Promise<string> {
    const secret = env.ACCESS_TOKEN_SECRET;
    const secretKey = crypto.createSecretKey(secret, "utf-8");

    return new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(env.ACCESS_TOKEN_TTL || "7d")
      .sign(secretKey);
  }

  generateRefreshToken(id: string): string {
    // Cryptographically random opaque token (not a JWT) – harder to forge,
    // easier to revoke without sharing secrets.
    const token = crypto.randomBytes(64).toString("hex");

    this.refreshTokenStore.set(token, {
      token,
      id,
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_MS),
      createdAt: new Date(),
    });

    return token;
  }

  async generateTokenPair(payload: JwtPayload) {
    return {
      accessToken: await this.generateAccessToken(payload),
      refreshToken: this.generateRefreshToken(payload.id),
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
    const stored = this.refreshTokenStore.get(incomingToken);

    if (!stored) {
      throw new Error("REFRESH_TOKEN_INVALID");
    }

    if (stored.expiresAt < new Date()) {
      this.refreshTokenStore.delete(incomingToken);
      throw new Error("REFRESH_TOKEN_EXPIRED");
    }

    // Invalidate the used token immediately (rotation – prevents replay attacks)
    this.refreshTokenStore.delete(incomingToken);

    const user = await this.userService.getUserById(stored.id);
    if (!user) throw new Error("UNKNOWN_USER");
    const authorization = await this.authorizationService.getAuthorizationForUser(stored.id);
    const tokenPair = await this.generateTokenPair(buildJwtClaims(user, authorization));

    return { tokenPair, id: stored.id };
  }

  // ---------------------------------------------------------------------------
  // Revocation
  // ---------------------------------------------------------------------------

  revokeRefreshToken(token: string): void {
    this.refreshTokenStore.delete(token);
  }

  revokeAllRefreshTokensForUser(id: string): void {
    for (const [key, value] of this.refreshTokenStore) {
      if (value.id === id) this.refreshTokenStore.delete(key);
    }
  }
}

export default TokenService;
