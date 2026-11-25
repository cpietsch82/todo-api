import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { todos, users } from "@/db/schema";
import AuthorizationService from "@modules/authorization/AuthorizationService";
import {
  createTodoListSchema,
  todoListInvitations,
  todoListMembers,
  todoLists,
} from "@modules/todo-lists/schema/todo-list.schema";
import { createTodoSchema, updateTodoSchema } from "@modules/todos/schema/todo.schema";
import { generateTodo, generateUser } from "@tests/test.helpers";
// registers the database cleanup hooks
import "@tests/integration.setup";

const LIST_PERMISSIONS = [
  "todo-lists:read",
  "todo-lists:create",
  "todo-lists:update",
  "todo-lists:delete",
  "todo-lists:share",
];

/** a todo record that passes the existing create schema */
const VALID_TODO = { title: "Hello world", description: "", status: "not_ready", tags: [] };

async function createList(ownerId: string, name = "Einkauf") {
  const [list] = await db.insert(todoLists).values({ name, ownerId }).returning();
  return list;
}

describe("todo list schema", () => {
  describe("permissions in the database", () => {
    it.each(["user", "admin"] as const)("should give the role %s the list permissions", async (role) => {
      const authorizationService = new AuthorizationService();
      const user = await generateUser();
      await authorizationService.assignRoleToUser(user.userId, role);

      const claims = (await authorizationService.readAuthorizations([user.userId])).get(user.userId)!;

      expect(claims.permissions).toEqual(expect.arrayContaining(LIST_PERMISSIONS));
    });
  });

  describe("constraints", () => {
    it("should reject a todo without creator and without list (chk_todos_owner_or_list)", async () => {
      await expect(db.insert(todos).values({ title: "Orphan todo", userId: null, listId: null })).rejects.toThrow();
    });

    it("should detach the todos of a deleted list", async () => {
      const owner = await generateUser();
      const list = await createList(owner.userId);
      const todo = await generateTodo(owner.userId, { listId: list.listId });

      await db.delete(todoLists).where(eq(todoLists.listId, list.listId));

      const [stored] = await db.select().from(todos).where(eq(todos.todoId, todo.todoId));
      expect(stored.listId).toBeNull();
      expect(stored.userId).toBe(owner.userId);
    });

    it("should keep a todo in a list when its creator is deleted", async () => {
      const owner = await generateUser();
      const member = await generateUser();
      const list = await createList(owner.userId);
      const todo = await generateTodo(member.userId, { listId: list.listId });

      await db.delete(users).where(eq(users.userId, member.userId));

      const [stored] = await db.select().from(todos).where(eq(todos.todoId, todo.todoId));
      expect(stored.listId).toBe(list.listId);
      expect(stored.userId).toBeNull();
    });

    it("should remove members of a deleted list", async () => {
      const owner = await generateUser();
      const member = await generateUser();
      const list = await createList(owner.userId);
      await db.insert(todoListMembers).values({ listId: list.listId, userId: member.userId, role: "editor" });

      await db.delete(todoLists).where(eq(todoLists.listId, list.listId));

      expect(await db.select().from(todoListMembers)).toHaveLength(0);
    });

    it("should allow either an invitee or a token hash, not both and not none", async () => {
      const owner = await generateUser();
      const invitee = await generateUser();
      const list = await createList(owner.userId);
      const base = { listId: list.listId, invitedBy: owner.userId, expiresAt: new Date(Date.now() + 60_000) };

      await expect(db.insert(todoListInvitations).values(base)).rejects.toThrow();
      await expect(
        db.insert(todoListInvitations).values({ ...base, inviteeId: invitee.userId, tokenHash: "a".repeat(64) }),
      ).rejects.toThrow();

      const [invitation] = await db
        .insert(todoListInvitations)
        .values({ ...base, inviteeId: invitee.userId })
        .returning();
      expect(invitation.role).toBe("viewer");
    });

    it("should allow only one open invitation per person and list", async () => {
      const owner = await generateUser();
      const invitee = await generateUser();
      const list = await createList(owner.userId);
      const invitation = {
        listId: list.listId,
        inviteeId: invitee.userId,
        invitedBy: owner.userId,
        expiresAt: new Date(Date.now() + 60_000),
      };

      await db.insert(todoListInvitations).values(invitation);

      await expect(db.insert(todoListInvitations).values(invitation)).rejects.toThrow();
    });

    it("should start a todo with version 1", async () => {
      const owner = await generateUser();

      const todo = await generateTodo(owner.userId);

      expect(todo.version).toBe(1);
    });
  });

  describe("request schemas", () => {
    it("should trim the list name and reject empty, too long names and control characters", () => {
      expect(createTodoListSchema.parse({ listRecord: { name: "  Einkauf " } }).listRecord.name).toBe("Einkauf");
      expect(createTodoListSchema.safeParse({ listRecord: { name: "   " } }).success).toBe(false);
      expect(createTodoListSchema.safeParse({ listRecord: { name: "a".repeat(101) } }).success).toBe(false);
      expect(createTodoListSchema.safeParse({ listRecord: { name: "Ein\u0000kauf" } }).success).toBe(false);
    });

    it("should limit the description to 1000 characters", () => {
      expect(createTodoListSchema.safeParse({ listRecord: { name: "x", description: "a".repeat(1000) } }).success).toBe(true);
      expect(createTodoListSchema.safeParse({ listRecord: { name: "x", description: "a".repeat(1001) } }).success).toBe(false);
    });

    it("should not let a client set the version of a todo", () => {
      expect(createTodoSchema.parse({ todoRecord: { ...VALID_TODO, version: 7 } }).todoRecord).not.toHaveProperty(
        "version",
      );
      expect(updateTodoSchema.parse({ updates: { version: 7 } }).updates).not.toHaveProperty("version");
    });

    it("should accept a list id when a todo is created and null to take it out of its list", () => {
      const listId = "550e8400-e29b-41d4-a716-446655440000";

      expect(createTodoSchema.parse({ todoRecord: { ...VALID_TODO, listId } }).todoRecord.listId).toBe(listId);
      expect(updateTodoSchema.parse({ updates: { listId: null } }).updates.listId).toBeNull();
      expect(updateTodoSchema.safeParse({ updates: { listId: "no-uuid" } }).success).toBe(false);
    });
  });
});
