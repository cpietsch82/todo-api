import { BaseModule } from "../core/BaseModule";
import { users, type User } from "@/modules/users/schema/user.schema";
import { AuthorizationService, type RoleDefinition } from "@/modules/authorization/AuthorizationService";
import type { AuthorizationClaims, Permission, RoleName } from "@/modules/authorization/permissions";
import { UserService } from "../users/UserService";

/** A user as the admin area shows it: the profile plus the roles and the permissions that follow from them. */
export interface AdminUser {
  userId: string;
  email: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  createdAt: Date;
  updatedAt: Date;
  roles: RoleName[];
  permissions: Permission[];
}

export interface SetUserRolesRequest {
  userId: string;
  roles: RoleName[];
  /** the admin who changes the roles */
  actorId: string;
}

/** Explicit list of fields, so a new column of the users table is not returned by accident. */
function toAdminUser(user: User, claims: AuthorizationClaims | undefined): AdminUser {
  return {
    userId: user.userId,
    email: user.email,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    roles: [...(claims?.roles ?? [])].sort(),
    permissions: [...(claims?.permissions ?? [])].sort(),
  };
}

/**
 * The admin area's view of the users. Roles, permissions and the rules for changing them belong to the
 * AuthorizationService, which is injected.
 */
export class AdminService extends BaseModule {
  public static instance: AdminService;
  protected authorizationService: AuthorizationService;
  protected userService: UserService;

  constructor() {
    super("admin.service", "Business logic for administrative tasks");
    this.authorizationService = new AuthorizationService();
    this.userService = new UserService();

    if (!AdminService.instance) {
      AdminService.instance = this;
    }
    return AdminService.instance;
  }

  /** All users, ordered by username, each with roles and permissions. */
  async listUsers(): Promise<AdminUser[]> {
    const rows = await this.userService.getAllUsers(users.username);
    const claims = await this.authorizationService.readAuthorizations(rows.map((row) => row.userId));

    return rows.map((row) => toAdminUser(row, claims.get(row.userId)));
  }

  async getUser(userId: string): Promise<AdminUser | undefined> {
    const user = await this.userService.getUserById(userId);
    if (!user) return undefined;

    const claims = await this.authorizationService.readAuthorizations([userId]);
    return toAdminUser(user, claims.get(userId));
  }

  /** All roles with the permissions they grant. */
  async listRoles(): Promise<RoleDefinition[]> {
    return this.authorizationService.listRoles();
  }

  /**
   * Replaces the roles of a user (rules see AuthorizationService.replaceUserRoles) and returns the user with the
   * new roles and permissions.
   * @throws HttpError 400, 403, 404, 409
   */
  async setUserRoles(request: SetUserRolesRequest): Promise<AdminUser> {
    await this.authorizationService.replaceUserRoles(request);
    return (await this.getUser(request.userId))!;
  }
}

export default AdminService;
