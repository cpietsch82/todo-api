import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { SignJWT, UnsecuredJWT, decodeJwt, decodeProtectedHeader } from "jose";
import env from "../../../../env";
import TokenService, { JWT_AUDIENCE, JWT_ISSUER, type JwtPayload } from "@modules/authentication/TokenService";

const USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const CLAIMS = {
  id: USER_ID,
  email: "john.doe@example.com",
  username: "johndoe",
  roles: ["user"],
  permissions: ["todos:read"],
};

const secretKey = (secret = env.ACCESS_TOKEN_SECRET) => crypto.createSecretKey(secret, "utf-8");

interface SignOptions {
  claims?: Record<string, unknown>;
  alg?: string;
  secret?: string;
  issuer?: string | null;
  audience?: string | null;
  subject?: string | null;
  issuedAt?: boolean;
  expiresAt?: string | number | null;
}

/** builds a token like the TokenService does, each part can be changed or left out */
function signToken({
  claims = CLAIMS,
  alg = "HS256",
  secret,
  issuer = JWT_ISSUER,
  audience = JWT_AUDIENCE,
  subject = USER_ID,
  issuedAt = true,
  expiresAt = "15m",
}: SignOptions = {}) {
  const jwt = new SignJWT(claims).setProtectedHeader({ alg });
  if (issuer !== null) jwt.setIssuer(issuer);
  if (audience !== null) jwt.setAudience(audience);
  if (subject !== null) jwt.setSubject(subject);
  if (issuedAt) jwt.setIssuedAt();
  if (expiresAt !== null) jwt.setExpirationTime(expiresAt);

  return jwt.sign(secretKey(secret));
}

describe("access token", () => {
  const service = new TokenService();

  describe("generateAccessToken", () => {
    it("should sign with HS256 and set issuer, audience, subject and expiry", async () => {
      const token = await service.generateAccessToken(CLAIMS as JwtPayload);

      expect(decodeProtectedHeader(token).alg).toBe("HS256");
      expect(decodeJwt(token)).toMatchObject({
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
        sub: USER_ID,
        id: USER_ID,
        roles: ["user"],
      });
      expect(decodeJwt(token).exp).toBeGreaterThan(Date.now() / 1000);
    });
  });

  describe("verifyAccessToken", () => {
    it("should accept a token created by the service", async () => {
      const token = await service.generateAccessToken(CLAIMS as JwtPayload);

      const payload = await service.verifyAccessToken(token);

      expect(payload).toMatchObject({ id: USER_ID, email: CLAIMS.email, permissions: ["todos:read"] });
    });

    it("should accept a correctly built token", async () => {
      await expect(service.verifyAccessToken(await signToken())).resolves.toMatchObject({ id: USER_ID });
    });

    it.each([
      ["a different secret", () => signToken({ secret: "another-secret-another-secret-another" })],
      ["another algorithm (HS512)", () => signToken({ alg: "HS512" })],
      ["a wrong issuer", () => signToken({ issuer: "someone-else" })],
      ["no issuer", () => signToken({ issuer: null })],
      ["a wrong audience", () => signToken({ audience: "another-api" })],
      ["no audience", () => signToken({ audience: null })],
      ["no subject", () => signToken({ subject: null })],
      ["a subject that does not match the id", () => signToken({ subject: "550e8400-e29b-41d4-a716-446655440001" })],
      ["no issued at", () => signToken({ issuedAt: false })],
      ["no expiry", () => signToken({ expiresAt: null })],
      ["an expired token", () => signToken({ expiresAt: Math.floor(Date.now() / 1000) - 60 })],
      ["an id that is no uuid", () => signToken({ claims: { ...CLAIMS, id: "1" }, subject: "1" })],
      ["permissions that are no list", () => signToken({ claims: { ...CLAIMS, permissions: "admin:all" } })],
      ["missing roles", () => signToken({ claims: { id: USER_ID, email: "a@b.de", username: "a", permissions: [] } })],
      ["an unsigned token", () => new UnsecuredJWT(CLAIMS).setIssuer(JWT_ISSUER).setAudience(JWT_AUDIENCE).setSubject(USER_ID).setIssuedAt().setExpirationTime("15m").encode()],
      ["a random string", () => "not-a-jwt"],
      ["an empty string", () => ""],
    ])("should reject %s", async (_name, createToken) => {
      await expect(service.verifyAccessToken(await createToken())).rejects.toThrow();
    });

    it("should reject a token with a manipulated payload", async () => {
      const [header, , signature] = (await signToken()).split(".");
      const forgedPayload = Buffer.from(JSON.stringify({ ...CLAIMS, permissions: ["admin:all"], sub: USER_ID, iss: JWT_ISSUER, aud: JWT_AUDIENCE, iat: 1, exp: 99999999999 })).toString("base64url");

      await expect(service.verifyAccessToken(`${header}.${forgedPayload}.${signature}`)).rejects.toThrow();
    });
  });
});
