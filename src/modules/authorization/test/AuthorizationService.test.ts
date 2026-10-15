import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { AuthorizationService } from "@modules/authorization/AuthorizationService";
import { roles, userRoles } from "@modules/authorization/schema/authorization.schema";
import { ROLE_PERMISSIONS } from "@modules/authorization/permissions";
import { NON_EXISTENT_UUID, generateUser } from "@tests/test.helpers";
// registers the database cleanup hooks (users are removed after each test)
import "@tests/integration.setup";
import type { User } from "@/db/schema";

describe("AuthorizationService", () => {
  const service = new AuthorizationService();
  let testUser: User;

  const getAssignedRoleNames = async (userId: string) => {
    const rows = await db
      .select({ name: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.roleId))
      .where(eq(userRoles.userId, userId));

    return rows.map((row) => row.name);
  };

  beforeEach(async () => {
    testUser = await generateUser();
  });

  // ---------------------------------------------------------------------------
  // assignRoleToUser
  // ---------------------------------------------------------------------------
  describe("assignRoleToUser", () => {
    it("should assign an existing role to a user", async () => {
      await service.assignRoleToUser(testUser.userId, "admin");

      expect(await getAssignedRoleNames(testUser.userId)).toContain("admin");
    });

    it("should not create a duplicate when the role is assigned twice", async () => {
      await service.assignRoleToUser(testUser.userId, "user");
      await service.assignRoleToUser(testUser.userId, "user");

      expect(await getAssignedRoleNames(testUser.userId)).toEqual(["user"]);
    });

    it("should throw ROLE_NOT_FOUND for an unknown role", async () => {
      await expect(service.assignRoleToUser(testUser.userId, "does-not-exist")).rejects.toThrow(
        "ROLE_NOT_FOUND:does-not-exist",
      );
    });

    it("should fail for a non-existent user", async () => {
      await expect(service.assignRoleToUser(NON_EXISTENT_UUID, "user")).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // ensureDefaultRoleAssignment
  // ---------------------------------------------------------------------------
  describe("ensureDefaultRoleAssignment", () => {
    it("should assign the default user role when the user has no role", async () => {
      await service.ensureDefaultRoleAssignment(testUser.userId);

      expect(await getAssignedRoleNames(testUser.userId)).toEqual(["user"]);
    });

    it("should keep an existing role and not add the default role", async () => {
      await service.assignRoleToUser(testUser.userId, "admin");

      await service.ensureDefaultRoleAssignment(testUser.userId);

      expect(await getAssignedRoleNames(testUser.userId)).toEqual(["admin"]);
    });
  });

  // ---------------------------------------------------------------------------
  // getAuthorizationForUser
  // ---------------------------------------------------------------------------
  describe("getAuthorizationForUser", () => {
    it("should resolve the default user role and its permissions", async () => {
      const result = await service.getAuthorizationForUser(testUser.userId);

      expect(result.roles).toEqual(["user"]);
      expect(result.permissions).toHaveLength(ROLE_PERMISSIONS.user.length);
      expect(result.permissions).toEqual(expect.arrayContaining([...ROLE_PERMISSIONS.user]));
      expect(result.permissions).not.toContain("admin:all");
    });

    it("should resolve the admin role including admin:all", async () => {
      await service.assignRoleToUser(testUser.userId, "admin");

      const result = await service.getAuthorizationForUser(testUser.userId);

      expect(result.roles).toEqual(["admin"]);
      expect(result.permissions).toContain("admin:all");
      expect(result.permissions).toHaveLength(ROLE_PERMISSIONS.admin.length);
    });

    it("should merge multiple roles without duplicate permissions", async () => {
      await service.assignRoleToUser(testUser.userId, "user");
      await service.assignRoleToUser(testUser.userId, "admin");

      const result = await service.getAuthorizationForUser(testUser.userId);

      expect(result.roles).toHaveLength(2);
      expect(result.roles).toEqual(expect.arrayContaining(["user", "admin"]));
      expect(result.permissions).toHaveLength(new Set(result.permissions).size);
      expect(result.permissions).toHaveLength(ROLE_PERMISSIONS.admin.length);
    });

    it("should persist the default role assignment for a user without roles", async () => {
      await service.getAuthorizationForUser(testUser.userId);

      expect(await getAssignedRoleNames(testUser.userId)).toEqual(["user"]);
    });

    it("should fail for a non-existent user", async () => {
      await expect(service.getAuthorizationForUser(NON_EXISTENT_UUID)).rejects.toThrow();
    });
  });
});
