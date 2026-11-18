export type UserRole = "user" | "admin" | "deployer";
export type RoleName = string;

// Operations on the docker containers of the NAS. Status and logs cover all containers of the compose file,
// pull, deploy (update and rollback) and restart only the api container.
export const DOCKER_PERMISSIONS = [
  "admin:docker:status",
  "admin:docker:logs",
  "admin:docker:pull",
  "admin:docker:deploy",
  "admin:docker:restart",
] as const;

export type DockerPermission = (typeof DOCKER_PERMISSIONS)[number];

export type Permission =
  | DockerPermission
  | "admin:all"
  | "todos:read"
  | "todos:create"
  | "todos:update"
  | "todos:delete"
  | "todo-comments:read"
  | "todo-comments:create"
  | "todo-comments:update"
  | "todo-comments:delete"
  | "users:read"
  | "users:list"
  | "users:update"
  | "users:delete";

const USER_PERMISSIONS: readonly Permission[] = [
  "todos:read",
  "todos:create",
  "todos:update",
  "todos:delete",
  "todo-comments:read",
  "todo-comments:create",
  "todo-comments:update",
  "todo-comments:delete",
  "users:read",
  "users:update",
  "users:delete",
];

// users:list (list all users) is intentionally admin only, normal users may only read their own profile
const ADMIN_PERMISSIONS: readonly Permission[] = ["admin:all", "users:list", ...USER_PERMISSIONS];

// The docker operations are a separate role, so they can be given to single admins only. A deployer usually has the
// role user (or admin) as well, the roles are combined.
const DEPLOYER_PERMISSIONS: readonly Permission[] = [...DOCKER_PERMISSIONS];

export const ROLE_PERMISSIONS: Readonly<Record<UserRole, readonly Permission[]>> = {
  user: USER_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
  deployer: DEPLOYER_PERMISSIONS,
};

// Permissions which are NOT covered by admin:all, they have to be granted explicitly (by the role deployer).
// Controlling docker gives full control over the NAS, so being an admin of the api is not enough.
const EXPLICIT_PERMISSIONS: readonly Permission[] = DOCKER_PERMISSIONS;

export function isExplicitPermission(permission: Permission): boolean {
  return EXPLICIT_PERMISSIONS.includes(permission);
}

export interface PermissionSubject {
  userId: string;
  email: string;
  username: string;
}

export interface AuthorizationClaims {
  roles: RoleName[];
  permissions: Permission[];
}

export function getPermissionsForRole(role: UserRole): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function getPermissionsForRoles(roles: readonly UserRole[]): Permission[] {
  const collected = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) {
      collected.add(permission);
    }
  }
  return [...collected];
}

/**
 * admin:all grants every permission except the explicit ones (see EXPLICIT_PERMISSIONS).
 */
export function hasPermission(granted: readonly Permission[] | undefined, required: Permission): boolean {
  if (!granted) return false;
  if (granted.includes(required)) return true;
  return !isExplicitPermission(required) && granted.includes("admin:all");
}

export function hasEveryPermission(granted: readonly Permission[] | undefined, required: readonly Permission[]): boolean {
  return required.every((permission) => hasPermission(granted, permission));
}

export function hasAnyPermission(granted: readonly Permission[] | undefined, candidates: readonly Permission[]): boolean {
  return candidates.some((permission) => hasPermission(granted, permission));
}

export function buildJwtClaims(subject: PermissionSubject, authorization: AuthorizationClaims) {
  return {
    id: subject.userId,
    email: subject.email,
    username: subject.username,
    roles: authorization.roles,
    permissions: authorization.permissions,
  };
}
