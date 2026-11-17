import { describe, it, expect, vi, afterEach } from "vitest";
import type { NextFunction, Request, Response } from "express";
import crypto from "node:crypto";
import { SignJWT } from "jose";
import env from "../../../env";
import { createAuthMiddleware } from "@/middleware/authenticateToken";
import TokenService, { JWT_AUDIENCE, JWT_ISSUER } from "@modules/authentication/TokenService";
import { logger } from "@/utils/logger";
import { createTestToken, generateUser } from "@tests/test.helpers";
// registers the database cleanup hooks (users are removed after each test)
import "@tests/integration.setup";

function run(authorization?: string) {
  const req = { headers: authorization === undefined ? {} : { authorization }, path: "/x", method: "GET" } as Request;
  const res = { setHeader: vi.fn() } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;

  const middleware = createAuthMiddleware(new TokenService());

  return Promise.resolve(middleware(req, res, next) as unknown as Promise<void>).then(() => ({ req, res, next }));
}

describe("authenticate middleware", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should continue without a user when there is no Authorization header", async () => {
    const { req, res, next } = await run();

    expect(req.authenticated).toBe(false);
    expect(req.user).toBeUndefined();
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it.each(["Bearer", "bearer", "BEARER"])("should accept a valid token with the scheme written as %s", async (scheme) => {
    const user = await generateUser();
    const token = await createTestToken(user);

    const { req, next } = await run(`${scheme} ${token}`);

    expect(req.authenticated).toBe(true);
    expect(req.user?.id).toBe(user.userId);
    expect(next).toHaveBeenCalledOnce();
  });

  it.each([
    ["an invalid token", "Bearer not-a-valid-token"],
    ["another scheme", "Basic dXNlcjpwdw=="],
    ["a missing token", "Bearer"],
    ["a missing token with a space", "Bearer "],
    ["two tokens", "Bearer abc def"],
    ["the token without a scheme", "abc.def.ghi"],
  ])("should treat %s as not authenticated, tell why and continue", async (_name, header) => {
    const { req, res, next } = await run(header);

    expect(req.authenticated).toBe(false);
    expect(req.user).toBeUndefined();
    expect(res.setHeader).toHaveBeenCalledWith("WWW-Authenticate", 'Bearer error="invalid_token"');
    expect(next).toHaveBeenCalledOnce();
  });

  it("should treat an expired token as not authenticated", async () => {
    const user = await generateUser();
    const expiredToken = await new SignJWT({
      id: user.userId,
      email: user.email,
      username: user.username,
      roles: ["user"],
      permissions: [],
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setSubject(user.userId)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(crypto.createSecretKey(env.ACCESS_TOKEN_SECRET, "utf-8"));

    const { req, res } = await run(`Bearer ${expiredToken}`);

    expect(req.authenticated).toBe(false);
    expect(res.setHeader).toHaveBeenCalledWith("WWW-Authenticate", 'Bearer error="invalid_token"');
  });

  it("should never log the token", async () => {
    const warn = vi.spyOn(logger, "warn");
    const secretLookingToken = "SUPER.SECRET.TOKEN-VALUE";

    await run(`Bearer ${secretLookingToken}`);

    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secretLookingToken);
  });
});
