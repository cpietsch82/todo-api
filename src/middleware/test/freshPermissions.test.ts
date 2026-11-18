import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { userRoles } from "@modules/authorization/schema/authorization.schema";
import AuthorizationService from "@modules/authorization/AuthorizationService";
import { DOCKER_PERMISSIONS, getPermissionsForRoles, type Permission } from "@modules/authorization/permissions";
import { requireAnyFreshPermission, requireFreshPermissions } from "@/middleware/permissions";
import { generateUser } from "@tests/test.helpers";
import type { User } from "@/db/schema";
// registers the database cleanup hooks (users are removed after each test)
import "@tests/integration.setup";

/** a request whose access token claims the given permissions, the database decides what the user really has */
async function run(handler: ReturnType<typeof requireFreshPermissions>, user: User | undefined, tokenPermissions: Permission[]) {
  const req = {
    authenticated: Boolean(user),
    user: user ? { id: user.userId, permissions: tokenPermissions } : undefined,
  } as unknown as Request;
  const res = {
    respondAuthorizationRequired: vi.fn(),
    respondAuthorizationInsufficient: vi.fn(),
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;

  await handler(req, res, next);
  return { res, next };
}

describe("permission checks against the database", () => {
  const authorizationService = new AuthorizationService();
  let testUser: User;

  beforeEach(async () => {
    testUser = await generateUser();
  });

  describe("requireFreshPermissions", () => {
    it("should allow the request when the role in the database grants the permission", async () => {
      await authorizationService.assignRoleToUser(testUser.userId, "deployer");

      const { next } = await run(requireFreshPermissions("admin:docker:deploy"), testUser, []);

      expect(next).toHaveBeenCalledOnce();
    });

    it("should ignore permissions that only the access token claims", async () => {
      // e.g. an old token from before the role was revoked
      const { res, next } = await run(requireFreshPermissions("admin:docker:deploy"), testUser, [...DOCKER_PERMISSIONS]);

      expect(res.respondAuthorizationInsufficient).toHaveBeenCalledWith("Missing permissions: admin:docker:deploy", true);
      expect(next).not.toHaveBeenCalled();
    });

    it("should take a revoked role into account with the next request", async () => {
      await authorizationService.assignRoleToUser(testUser.userId, "deployer");
      const check = requireFreshPermissions("admin:docker:restart");
      const tokenPermissions = getPermissionsForRoles(["deployer"]);

      const before = await run(check, testUser, tokenPermissions);
      await db.delete(userRoles).where(eq(userRoles.userId, testUser.userId));
      const after = await run(check, testUser, tokenPermissions);

      expect(before.next).toHaveBeenCalledOnce();
      expect(after.next).not.toHaveBeenCalled();
      expect(after.res.respondAuthorizationInsufficient).toHaveBeenCalledOnce();
    });

    it("should not let an admin use the docker permissions without the role deployer", async () => {
      await authorizationService.assignRoleToUser(testUser.userId, "admin");

      const { res, next } = await run(requireFreshPermissions("admin:docker:pull"), testUser, ["admin:all"]);

      expect(res.respondAuthorizationInsufficient).toHaveBeenCalledOnce();
      expect(next).not.toHaveBeenCalled();
    });

    it("should require every listed permission", async () => {
      await authorizationService.assignRoleToUser(testUser.userId, "deployer");

      const { next } = await run(requireFreshPermissions("admin:docker:pull", "users:list"), testUser, []);

      expect(next).not.toHaveBeenCalled();
    });

    it("should answer 401 when the user was deleted after the token was issued", async () => {
      await authorizationService.assignRoleToUser(testUser.userId, "deployer");
      await db.delete(users).where(eq(users.userId, testUser.userId));

      const { res, next } = await run(requireFreshPermissions("admin:docker:status"), testUser, [...DOCKER_PERMISSIONS]);

      expect(res.respondAuthorizationRequired).toHaveBeenCalledOnce();
      expect(next).not.toHaveBeenCalled();
    });

    it("should answer 401 for a request without an authenticated user", async () => {
      const { res, next } = await run(requireFreshPermissions("admin:docker:status"), undefined, []);

      expect(res.respondAuthorizationRequired).toHaveBeenCalledOnce();
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("requireAnyFreshPermission", () => {
    const adminAreaGate = () => requireAnyFreshPermission("admin:all", ...DOCKER_PERMISSIONS);

    it.each(["admin", "deployer"])("should let the role %s pass", async (role) => {
      await authorizationService.assignRoleToUser(testUser.userId, role);

      const { next } = await run(adminAreaGate(), testUser, []);

      expect(next).toHaveBeenCalledOnce();
    });

    it("should reject a normal user", async () => {
      await authorizationService.assignRoleToUser(testUser.userId, "user");

      const { res, next } = await run(adminAreaGate(), testUser, ["admin:all"]);

      expect(res.respondAuthorizationInsufficient).toHaveBeenCalledOnce();
      expect(next).not.toHaveBeenCalled();
    });
  });
});
