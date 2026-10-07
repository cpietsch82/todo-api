import { db } from "@/db";
import { BaseModule } from "@modules/core/BaseModule";
import { permissions, rolePermissions, roles, userRoles } from "@/modules/authorization/schema/authorization.schema";
import { eq } from "drizzle-orm";
import type { AuthorizationClaims, Permission, RoleName } from "@/modules/authorization/permissions";

const DEFAULT_ROLE_NAME: RoleName = "user";

export class AuthorizationService extends BaseModule {
  public static instance: AuthorizationService;

  constructor() {
    super("authorization.service", "Business logic for authorization role and permission resolution");

    if (!AuthorizationService.instance) {
      AuthorizationService.instance = this;
    }

    return AuthorizationService.instance;
  }

  async assignRoleToUser(userId: string, roleName: RoleName): Promise<void> {
    const [role] = await db.select({ roleId: roles.roleId }).from(roles).where(eq(roles.name, roleName)).limit(1);
    if (!role) throw new Error(`ROLE_NOT_FOUND:${roleName}`);

    await db.insert(userRoles).values({ userId, roleId: role.roleId }).onConflictDoNothing();
  }

  async ensureDefaultRoleAssignment(userId: string): Promise<void> {
    const [assignedRole] = await db.select({ roleId: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, userId)).limit(1);
    if (!assignedRole) {
      await this.assignRoleToUser(userId, DEFAULT_ROLE_NAME);
    }
  }

  async getAuthorizationForUser(userId: string): Promise<AuthorizationClaims> {
    await this.ensureDefaultRoleAssignment(userId);

    const roleRows = await db
      .select({ roleName: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.roleId))
      .where(eq(userRoles.userId, userId));

    const permissionRows = await db
      .select({ permissionKey: permissions.key })
      .from(userRoles)
      .innerJoin(rolePermissions, eq(userRoles.roleId, rolePermissions.roleId))
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.permissionId))
      .where(eq(userRoles.userId, userId));

    const resolvedRoles = [...new Set(roleRows.map((row) => row.roleName))];
    const resolvedPermissions = [...new Set(permissionRows.map((row) => row.permissionKey as Permission))];

    return {
      roles: resolvedRoles,
      permissions: resolvedPermissions,
    };
  }
}

export default AuthorizationService;
