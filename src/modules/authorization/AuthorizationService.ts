import { db } from "@/db";
import { BaseModule } from "@modules/core/BaseModule";
import { permissions, rolePermissions, roles, userRoles } from "@/modules/authorization/schema/authorization.schema";
import { users } from "@/modules/users/schema/user.schema";
import { asc, eq, inArray } from "drizzle-orm";
import { HttpError } from "@/utils/HttpError";
import {
  ADMIN_ROLE,
  DEPLOYER_ROLE,
  type AuthorizationClaims,
  type Permission,
  type RoleName,
} from "@/modules/authorization/permissions";

const DEFAULT_ROLE_NAME: RoleName = "user";

/** the database or a running transaction, both can run the read queries */
type Executor = Pick<typeof db, "select">;

/** A role of the database with the permissions it grants. */
export interface RoleDefinition {
  name: RoleName;
  description: string | null;
  permissions: Permission[];
}

export interface ReplaceUserRolesRequest {
  userId: string;
  /** the complete new list of roles */
  roles: RoleName[];
  /** the user who changes the roles, checked against the rules of replaceUserRoles */
  actorId: string;
}

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

  /**
   * Resolves roles and permissions for a login or a token refresh. A user without a role gets the default role.
   */
  async getAuthorizationForUser(userId: string): Promise<AuthorizationClaims> {
    await this.ensureDefaultRoleAssignment(userId);

    return this.readAuthorization(userId);
  }

  /**
   * Reads the current roles and permissions from the database without changing anything, e.g. to check a request
   * against the database instead of the (up to ACCESS_TOKEN_TTL old) claims of its access token.
   * @returns undefined when the user does not exist (anymore)
   */
  async getStoredAuthorization(userId: string): Promise<AuthorizationClaims | undefined> {
    const [user] = await db.select({ userId: users.userId }).from(users).where(eq(users.userId, userId)).limit(1);
    if (!user) return undefined;

    return this.readAuthorization(userId);
  }

  /**
   * Roles and permissions of several users, read with two queries for all of them. Nothing is changed, a user without
   * a role gets empty lists.
   * @param executor the database or a running transaction
   */
  async readAuthorizations(userIds: readonly string[], executor: Executor = db): Promise<Map<string, AuthorizationClaims>> {
    const result = new Map<string, AuthorizationClaims>(userIds.map((userId) => [userId, { roles: [], permissions: [] }]));
    if (userIds.length === 0) return result;

    const ids = [...new Set(userIds)];
    const roleRows = await executor
      .select({ userId: userRoles.userId, roleName: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.roleId))
      .where(inArray(userRoles.userId, ids));

    const permissionRows = await executor
      .select({ userId: userRoles.userId, permissionKey: permissions.key })
      .from(userRoles)
      .innerJoin(rolePermissions, eq(userRoles.roleId, rolePermissions.roleId))
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.permissionId))
      .where(inArray(userRoles.userId, ids));

    // a role or permission can come from several rows (several roles grant the same permission)
    for (const { userId, roleName } of roleRows) {
      const claims = result.get(userId)!;
      if (!claims.roles.includes(roleName)) claims.roles.push(roleName);
    }
    for (const { userId, permissionKey } of permissionRows) {
      const claims = result.get(userId)!;
      if (!claims.permissions.includes(permissionKey as Permission)) claims.permissions.push(permissionKey as Permission);
    }

    return result;
  }

  /** All roles of the database with the permissions they grant, ordered by name. */
  async listRoles(): Promise<RoleDefinition[]> {
    const roleRows = await db.select().from(roles).orderBy(asc(roles.name));
    const permissionRows = await db
      .select({ roleId: rolePermissions.roleId, key: permissions.key })
      .from(rolePermissions)
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.permissionId));

    return roleRows.map((role) => ({
      name: role.name,
      description: role.description,
      permissions: permissionRows
        .filter((row) => row.roleId === role.roleId)
        .map((row) => row.key as Permission)
        .sort(),
    }));
  }

  /**
   * Replaces all roles of a user. Permissions are not assigned to users directly, they follow from the roles.
   *
   * Rules:
   * - only a deployer may grant or revoke the role deployer, otherwise an admin could give themselves control over
   *   docker, which admin:all deliberately does not include (403)
   * - nobody can remove their own role admin, so an admin cannot lock themselves out (409)
   * - the last admin keeps the role admin (409)
   *
   * The new roles take effect immediately where the permissions are read from the database (admin area) and
   * everywhere else with the next token refresh.
   * @throws HttpError 400 without a role or for an unknown role, 403, 404 for an unknown user, 409
   */
  async replaceUserRoles({ userId, roles: requestedRoles, actorId }: ReplaceUserRolesRequest): Promise<void> {
    const wanted = [...new Set(requestedRoles)];
    if (wanted.length === 0) throw HttpError.badRequest("A user needs at least one role");

    await db.transaction(async (tx) => {
      const [user] = await tx.select({ userId: users.userId }).from(users).where(eq(users.userId, userId)).limit(1);
      if (!user) throw HttpError.notFound();

      const roleRows = await tx.select({ roleId: roles.roleId, name: roles.name }).from(roles).where(inArray(roles.name, wanted));
      const unknown = wanted.filter((name) => !roleRows.some((row) => row.name === name));
      if (unknown.length > 0) throw HttpError.badRequest(`Unknown role: ${unknown.join(", ")}`);

      const claims = await this.readAuthorizations([userId, actorId], tx);
      const current = claims.get(userId)!.roles;
      const actorRoles = claims.get(actorId)!.roles;

      if (current.includes(DEPLOYER_ROLE) !== wanted.includes(DEPLOYER_ROLE) && !actorRoles.includes(DEPLOYER_ROLE)) {
        throw HttpError.forbidden(`Only a ${DEPLOYER_ROLE} may grant or revoke the role ${DEPLOYER_ROLE}`);
      }

      if (current.includes(ADMIN_ROLE) && !wanted.includes(ADMIN_ROLE)) {
        if (userId === actorId) throw HttpError.conflict(`You cannot remove your own role ${ADMIN_ROLE}`);

        const admins = await tx
          .select({ userId: userRoles.userId })
          .from(userRoles)
          .innerJoin(roles, eq(userRoles.roleId, roles.roleId))
          .where(eq(roles.name, ADMIN_ROLE));
        if (admins.every((row) => row.userId === userId)) {
          throw HttpError.conflict(`The last ${ADMIN_ROLE} cannot lose the role ${ADMIN_ROLE}`);
        }
      }

      await tx.delete(userRoles).where(eq(userRoles.userId, userId));
      await tx.insert(userRoles).values(roleRows.map((row) => ({ userId, roleId: row.roleId })));

      this.logger.info({ userId, actorId, previousRoles: [...current].sort(), roles: [...wanted].sort() }, "Roles of a user changed");
    });
  }

  private async readAuthorization(userId: string): Promise<AuthorizationClaims> {
    return (await this.readAuthorizations([userId])).get(userId)!;
  }
}

export default AuthorizationService;
