export type UserRole = "user" | "admin";
export type RoleName = string;

export type Permission =
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

const ADMIN_PERMISSIONS: readonly Permission[] = ["admin:all", ...USER_PERMISSIONS];

export const ROLE_PERMISSIONS: Readonly<Record<UserRole, readonly Permission[]>> = {
  user: USER_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
};

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

export function hasPermission(granted: readonly Permission[] | undefined, required: Permission): boolean {
  if (!granted) return false;
  return granted.includes("admin:all") || granted.includes(required);
}

export function hasEveryPermission(granted: readonly Permission[] | undefined, required: readonly Permission[]): boolean {
  return required.every((permission) => hasPermission(granted, permission));
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
