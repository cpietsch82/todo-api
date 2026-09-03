import { User, users, Todo, todos } from "@/db/schema";
import { db } from "@/db";
import TokenService from "@/modules/authentication/TokenService";
import { NewTodo } from "@/modules/todos/schema/todo.schema";
import { todoComments, TodoComment, NewTodoComment } from "@/modules/todos/schema/todo.comment.schema";

/** A valid UUID that is guaranteed not to exist in the test database. */
export const NON_EXISTENT_UUID = "550e8400-e29b-41d4-a716-446655440000";

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Counter used to generate unique email addresses / usernames within a test run.
// PGlite runs per Vitest worker, so the counter resets naturally per file.
let _userCounter = 0;

export async function generateUser(payload?: Partial<User>): Promise<User> {
  const n = ++_userCounter;
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

export async function createTestToken(user: User): Promise<string> {
  const tokenService = new TokenService();
  const { accessToken } = await tokenService.generateTokenPair({
    id: user.userId,
    email: user.email,
    username: user.username,
  });
  return accessToken;
}

export async function createAuthHeader(user: User): Promise<{ Authorization: string }> {
  const token = await createTestToken(user);
  return { Authorization: `Bearer ${token}` };
}
