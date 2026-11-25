import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { todos, users, type User } from "@/db/schema";
import { todoListMembers, todoLists, type MemberRole, type TodoList } from "@modules/todo-lists/schema/todo-list.schema";
import { TodoListService } from "@modules/todo-lists/TodoListService";
import { hasListRole } from "@modules/todo-lists/listRoles";
import UserService from "@modules/users/UserService";
import { generateTodo, generateUser } from "@tests/test.helpers";
// registers the database cleanup hooks
import "@tests/integration.setup";

const service = new TodoListService();

async function createList(ownerId: string, name = "Einkauf"): Promise<TodoList> {
  const [list] = await db.insert(todoLists).values({ name, ownerId }).returning();
  return list;
}

async function addMember(listId: string, userId: string, role: MemberRole) {
  await db.insert(todoListMembers).values({ listId, userId, role });
}

const todoById = async (todoId: string) => (await db.select().from(todos).where(eq(todos.todoId, todoId)))[0];

describe("hasListRole", () => {
  it("should rank owner above editor above viewer", () => {
    expect(hasListRole("owner", "editor")).toBe(true);
    expect(hasListRole("editor", "editor")).toBe(true);
    expect(hasListRole("viewer", "editor")).toBe(false);
    expect(hasListRole("viewer", "viewer")).toBe(true);
  });

  it("should give no role nothing", () => {
    expect(hasListRole(undefined, "viewer")).toBe(false);
  });
});

describe("TodoListService", () => {
  let owner: User;
  let member: User;
  let stranger: User;
  let list: TodoList;

  beforeEach(async () => {
    owner = await generateUser();
    member = await generateUser();
    stranger = await generateUser();
    list = await createList(owner.userId);
  });

  describe("getListRole", () => {
    it("should make the owner of a list its owner", async () => {
      expect(await service.getListRole(list, { id: owner.userId })).toBe("owner");
    });

    it("should treat an admin as owner of every list", async () => {
      expect(await service.getListRole(list, { id: stranger.userId, permissions: ["admin:all"] })).toBe("owner");
    });

    it("should read the role of a member from the database", async () => {
      await addMember(list.listId, member.userId, "editor");

      expect(await service.getListRole(list, { id: member.userId })).toBe("editor");
    });

    it("should give a stranger no role", async () => {
      expect(await service.getListRole(list, { id: stranger.userId })).toBeUndefined();
    });
  });

  describe("getListsForUser", () => {
    it("should return own and shared lists with role and counts, but no foreign ones", async () => {
      const shared = await createList(stranger.userId, "Geteilt");
      await createList(stranger.userId, "Fremd");
      await addMember(shared.listId, owner.userId, "viewer");
      await addMember(list.listId, member.userId, "editor");
      await generateTodo(owner.userId, { listId: list.listId });
      await generateTodo(member.userId, { listId: list.listId });

      const lists = await service.getListsForUser(owner.userId);

      expect(lists.map((l) => l.name)).toEqual(["Einkauf", "Geteilt"]);
      expect(lists[0]).toMatchObject({ listId: list.listId, myRole: "owner", todoCount: 2, memberCount: 1 });
      expect(lists[1]).toMatchObject({ listId: shared.listId, myRole: "viewer", todoCount: 0, memberCount: 1 });
    });
  });

  describe("deleteList", () => {
    it("should give the todos back to their creators and delete the todos of deleted users", async () => {
      await addMember(list.listId, member.userId, "editor");
      const ownTodo = await generateTodo(owner.userId, { listId: list.listId });
      const memberTodo = await generateTodo(member.userId, { listId: list.listId });
      const gone = await generateUser();
      const todoOfDeletedUser = await generateTodo(gone.userId, { listId: list.listId });
      await db.delete(users).where(eq(users.userId, gone.userId));

      const deleted = await service.deleteList(list.listId);

      expect(deleted?.listId).toBe(list.listId);
      expect(await todoById(ownTodo.todoId)).toMatchObject({ listId: null, userId: owner.userId });
      expect(await todoById(memberTodo.todoId)).toMatchObject({ listId: null, userId: member.userId });
      expect(await todoById(todoOfDeletedUser.todoId)).toBeUndefined();
      expect(await db.select().from(todoListMembers)).toHaveLength(0);
    });

    it("should return undefined for a list that does not exist", async () => {
      await service.deleteList(list.listId);

      expect(await service.deleteList(list.listId)).toBeUndefined();
    });
  });

  describe("getTodosOfList", () => {
    it("should return only the todos of the list, oldest first", async () => {
      const second = await generateTodo(member.userId, { listId: list.listId });
      const first = await generateTodo(owner.userId, { listId: list.listId });
      // created in the other order than they are listed
      await db.update(todos).set({ createdAt: new Date("2026-01-01") }).where(eq(todos.todoId, first.todoId));
      await db.update(todos).set({ createdAt: new Date("2026-02-01") }).where(eq(todos.todoId, second.todoId));
      await generateTodo(owner.userId);

      const listTodos = await service.getTodosOfList(list.listId);

      expect(listTodos.map((t) => t.todoId)).toEqual([first.todoId, second.todoId]);
    });
  });
});

describe("UserService.deleteUser with lists", () => {
  it("should leave no todo behind that belongs to nobody", async () => {
    const owner = await generateUser();
    const member = await generateUser();
    const other = await generateUser();
    const ownList = await createList(owner.userId);
    const foreignList = await createList(other.userId);
    await addMember(ownList.listId, member.userId, "editor");
    await addMember(foreignList.listId, owner.userId, "editor");
    const ownerTodoInOwnList = await generateTodo(owner.userId, { listId: ownList.listId });
    const memberTodoInOwnList = await generateTodo(member.userId, { listId: ownList.listId });
    const privateTodo = await generateTodo(owner.userId);
    const ownerTodoInForeignList = await generateTodo(owner.userId, { listId: foreignList.listId });

    await new UserService().deleteUser(owner.userId);

    expect(await db.select().from(todoLists).where(eq(todoLists.listId, ownList.listId))).toHaveLength(0);
    expect(await todoById(ownerTodoInOwnList.todoId)).toBeUndefined();
    expect(await todoById(privateTodo.todoId)).toBeUndefined();
    expect(await todoById(memberTodoInOwnList.todoId)).toMatchObject({ listId: null, userId: member.userId });
    expect(await todoById(ownerTodoInForeignList.todoId)).toMatchObject({ listId: foreignList.listId, userId: null });
  });
});
