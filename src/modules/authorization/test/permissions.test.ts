import { describe, it, expect } from "vitest";
import {
  buildJwtClaims,
  getPermissionsForRole,
  getPermissionsForRoles,
  hasEveryPermission,
  hasPermission,
  ROLE_PERMISSIONS,
} from "@modules/authorization/permissions";

describe("permissions", () => {
  // ---------------------------------------------------------------------------
  // getPermissionsForRole / getPermissionsForRoles
  // ---------------------------------------------------------------------------
  describe("getPermissionsForRole", () => {
    it("should return the permissions of the user role without admin:all", () => {
      const result = getPermissionsForRole("user");

      expect(result).toEqual([...ROLE_PERMISSIONS.user]);
      expect(result).toContain("todos:read");
      expect(result).not.toContain("admin:all");
    });

    it("should return admin:all and all user permissions for the admin role", () => {
      const result = getPermissionsForRole("admin");

      expect(result).toContain("admin:all");
      for (const permission of ROLE_PERMISSIONS.user) {
        expect(result).toContain(permission);
      }
    });

    it("should return a copy that does not modify the role definition", () => {
      const result = getPermissionsForRole("user");
      result.push("admin:all");

      expect(ROLE_PERMISSIONS.user).not.toContain("admin:all");
    });
  });

  describe("getPermissionsForRoles", () => {
    it("should merge the permissions of multiple roles without duplicates", () => {
      const result = getPermissionsForRoles(["user", "admin"]);

      expect(result).toHaveLength(new Set(result).size);
      expect(result).toContain("admin:all");
      expect(result).toContain("users:delete");
    });

    it("should return an empty list when no roles are given", () => {
      expect(getPermissionsForRoles([])).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // hasPermission
  // ---------------------------------------------------------------------------
  describe("hasPermission", () => {
    it("should return true when the permission is granted", () => {
      expect(hasPermission(["todos:read"], "todos:read")).toBe(true);
    });

    it("should return true for any permission when admin:all is granted", () => {
      expect(hasPermission(["admin:all"], "users:delete")).toBe(true);
    });

    it("should return false when the permission is not granted", () => {
      expect(hasPermission(["todos:read"], "todos:delete")).toBe(false);
    });

    it("should return false for an empty permission list", () => {
      expect(hasPermission([], "todos:read")).toBe(false);
    });

    it("should return false when no permissions are defined", () => {
      expect(hasPermission(undefined, "todos:read")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // hasEveryPermission
  // ---------------------------------------------------------------------------
  describe("hasEveryPermission", () => {
    it("should return true when all required permissions are granted", () => {
      expect(hasEveryPermission(["todos:read", "todos:create"], ["todos:read", "todos:create"])).toBe(true);
    });

    it("should return true when admin:all covers all required permissions", () => {
      expect(hasEveryPermission(["admin:all"], ["todos:read", "users:delete"])).toBe(true);
    });

    it("should return false when one required permission is missing", () => {
      expect(hasEveryPermission(["todos:read"], ["todos:read", "todos:create"])).toBe(false);
    });

    it("should return true when nothing is required", () => {
      expect(hasEveryPermission([], [])).toBe(true);
    });

    it("should return false when no permissions are defined but some are required", () => {
      expect(hasEveryPermission(undefined, ["todos:read"])).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // buildJwtClaims
  // ---------------------------------------------------------------------------
  describe("buildJwtClaims", () => {
    it("should map the subject and authorization to JWT claims", () => {
      const claims = buildJwtClaims(
        { userId: "user-1", email: "a@test.com", username: "alice" },
        { roles: ["user"], permissions: ["todos:read"] },
      );

      expect(claims).toEqual({
        id: "user-1",
        email: "a@test.com",
        username: "alice",
        roles: ["user"],
        permissions: ["todos:read"],
      });
    });
  });
});
