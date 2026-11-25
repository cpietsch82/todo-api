import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import type { User } from "@/db/schema";
import { todoListMembers, todoLists, type MemberRole, type TodoList } from "@modules/todo-lists/schema/todo-list.schema";
import { TodoListAPI } from "@modules/todo-lists/TodoListAPI";
import { TodoListService } from "@modules/todo-lists/TodoListService";
import { MAX_LISTS_PER_USER } from "@modules/todo-lists/limits";
import { createAuthHeader, generateUser } from "@tests/test.helpers";
import { getTestServer } from "@tests/integration.setup";

async function createList(ownerId: string, name = "Einkauf"): Promise<TodoList> {
  const [list] = await db.insert(todoLists).values({ name, ownerId }).returning();
  return list;
}

async function addMember(listId: string, userId: string, role: MemberRole) {
  await db.insert(todoListMembers).values({ listId, userId, role });
}

const listById = async (listId: string) => (await db.select().from(todoLists).where(eq(todoLists.listId, listId)))[0];
const membersOf = async (listId: string) =>
  db
    .select({ userId: todoListMembers.userId, role: todoListMembers.role })
    .from(todoListMembers)
    .where(eq(todoListMembers.listId, listId));

describe("POST /api/todo-lists/:listId/transfer", () => {
  let server: Server;
  let owner: User;
  let editor: User;
  let viewer: User;
  let stranger: User;
  let list: TodoList;

  const transfer = async (actor: User, userId: string, options = {}) =>
    request(server)
      .post(`/api/todo-lists/${list.listId}/transfer`)
      .set(await createAuthHeader(actor, options))
      .send({ userId });

  beforeAll(() => {
    new TodoListAPI();
    server = getTestServer();
  });

  beforeEach(async () => {
    owner = await generateUser();
    editor = await generateUser();
    viewer = await generateUser();
    stranger = await generateUser();
    list = await createList(owner.userId);
    await addMember(list.listId, editor.userId, "editor");
    await addMember(list.listId, viewer.userId, "viewer");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should make the member the owner and the old owner an editor", async () => {
    const response = await transfer(owner, viewer.userId);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ listId: list.listId, ownerId: viewer.userId, myRole: "editor", memberCount: 2 });
    expect((await listById(list.listId)).ownerId).toBe(viewer.userId);
    expect(await membersOf(list.listId)).toEqual(
      expect.arrayContaining([
        { userId: owner.userId, role: "editor" },
        { userId: editor.userId, role: "editor" },
      ]),
    );
    expect(await membersOf(list.listId)).toHaveLength(2);
  });

  it("should answer 409 when the target is not a member", async () => {
    for (const target of [stranger, owner]) {
      const response = await transfer(owner, target.userId);

      expect(response.status).toBe(409);
      expect(response.text).toBe("The new owner must be a member of the list");
    }
    expect((await listById(list.listId)).ownerId).toBe(owner.userId);
  });

  it.each([
    ["editor", 403],
    ["viewer", 403],
    ["stranger", 403],
  ] as const)("transfer as %s → %i", async (actor, status) => {
    const users = { editor, viewer, stranger };

    const response = await transfer(users[actor], editor.userId);

    expect(response.status).toBe(status);
    expect((await listById(list.listId)).ownerId).toBe(owner.userId);
  });

  it("should need todo-lists:share", async () => {
    const response = await transfer(owner, viewer.userId, { permissions: ["todo-lists:read"] });

    expect(response.status).toBe(403);
  });

  it("should let an admin transfer a foreign list, the old owner becomes editor", async () => {
    const admin = await generateUser();

    const response = await transfer(admin, viewer.userId, { role: "admin" });

    expect(response.status).toBe(200);
    expect(response.body.myRole).toBe("owner");
    expect((await listById(list.listId)).ownerId).toBe(viewer.userId);
    expect(await membersOf(list.listId)).toEqual(expect.arrayContaining([{ userId: owner.userId, role: "editor" }]));
  });

  it("should answer 409 for the second of two transfers", async () => {
    // the first transfer is through; the second request was checked against the list as it was before
    await transfer(owner, viewer.userId);
    vi.spyOn(TodoListService.prototype, "getListById").mockResolvedValue(list);

    const response = await transfer(owner, editor.userId);

    expect(response.status).toBe(409);
    expect(response.text).toBe("The list changed meanwhile, please try again");
    expect((await listById(list.listId)).ownerId).toBe(viewer.userId);
  });

  it("should answer 409 when the target owns the list limit already", async () => {
    await db
      .insert(todoLists)
      .values(Array.from({ length: MAX_LISTS_PER_USER }, (_, i) => ({ name: `Liste ${i}`, ownerId: viewer.userId })));

    const response = await transfer(owner, viewer.userId);

    expect(response.status).toBe(409);
    expect(response.text).toBe("List limit reached");
    expect((await listById(list.listId)).ownerId).toBe(owner.userId);
  });

  it("should let the new owner manage the members right away", async () => {
    await transfer(owner, viewer.userId);

    const byNewOwner = await request(server)
      .patch(`/api/todo-lists/${list.listId}/members/${editor.userId}`)
      .set(await createAuthHeader(viewer))
      .send({ role: "viewer" });
    const byOldOwner = await request(server)
      .patch(`/api/todo-lists/${list.listId}/members/${editor.userId}`)
      .set(await createAuthHeader(owner))
      .send({ role: "editor" });

    expect(byNewOwner.status).toBe(200);
    expect(byOldOwner.status).toBe(403);
  });

  it("should answer 400 for a userId that is no uuid", async () => {
    const response = await transfer(owner, "abc");

    expect(response.status).toBe(400);
  });
});
