import { User, users, Todo, todos } from "@/db/schema";
import { db } from "@/db";
import TokenService from "@/modules/authentication/TokenService";
import { buildJwtClaims, getPermissionsForRoles, type Permission, type UserRole } from "@/modules/authorization/permissions";
import { todoComments, TodoComment, NewTodoComment } from "@/modules/todos/schema/todo.comment.schema";
import { NewTodo } from "@/modules/todos/schema/todo.schema";

/** A valid UUID that is guaranteed not to exist in the test database. */
export const NON_EXISTENT_UUID = "550e8400-e29b-41d4-a716-446655440000";

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let userCounter = 0;

export async function generateUser(payload?: Partial<User>): Promise<User> {
  const n = ++userCounter;
  const testUser = {
    email: `testuser${n}@test.com`,
    username: `testuser${n}`,
    ...payload,
  };

  const [user] = await db.insert(users).values(testUser).returning();
  return user;
}

export async function generateTodo(userId: string, payload?: Partial<NewTodo>): Promise<Todo> {
  const [todo] = await db
    .insert(todos)
    .values({ title: "Test Todo", userId, ...payload })
    .returning();
  return todo;
}

export async function generateTodoComment(
  todoId: string,
  userId: string,
  payload?: Partial<NewTodoComment>,
): Promise<TodoComment> {
  const [comment] = await db
    .insert(todoComments)
    .values({ todoId, userId, comment: "Test comment", ...payload })
    .returning();

  return comment;
}

export interface TestTokenOptions {
  role?: UserRole;
  roles?: UserRole[];
  permissions?: Permission[];
}

export async function createTestToken(user: User, options: TestTokenOptions = {}): Promise<string> {
  const roles = options.roles ?? [options.role ?? "user"];
  const tokenService = new TokenService();

  return tokenService.generateAccessToken({
    ...buildJwtClaims(user, {
      roles,
      permissions: options.permissions ?? getPermissionsForRoles(roles),
    }),
  });
}

export async function createAuthHeader(
  user: User,
  options: TestTokenOptions = {},
): Promise<{ Authorization: string }> {
  const token = await createTestToken(user, options);
  return { Authorization: `Bearer ${token}` };
}
