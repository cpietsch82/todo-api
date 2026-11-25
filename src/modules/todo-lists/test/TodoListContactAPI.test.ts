import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import type { User } from "@/db/schema";
import { todoListMembers, todoLists, type MemberRole, type TodoList } from "@modules/todo-lists/schema/todo-list.schema";
import { TodoListContactAPI } from "@modules/todo-lists/TodoListContactAPI";
import { createAuthHeader, generateUser } from "@tests/test.helpers";
import { getTestServer } from "@tests/integration.setup";

async function createList(ownerId: string, name = "Einkauf"): Promise<TodoList> {
  const [list] = await db.insert(todoLists).values({ name, ownerId }).returning();
  return list;
}

async function addMember(listId: string, userId: string, role: MemberRole = "viewer") {
  await db.insert(todoListMembers).values({ listId, userId, role });
}

describe("GET /api/todo-list-contacts", () => {
  let server: Server;
  let me: User;
  let anna: User;
  let bert: User;
  let carl: User;
  let dora: User;
  let stranger: User;

  const contactsOf = async (user: User, options = {}) =>
    request(server)
      .get("/api/todo-list-contacts")
      .set(await createAuthHeader(user, options));

  beforeAll(() => {
    new TodoListContactAPI();
    server = getTestServer();
  });

  beforeEach(async () => {
    me = await generateUser({ username: "ich" });
    anna = await generateUser({ username: "anna" });
    bert = await generateUser({ username: "bert" });
    carl = await generateUser({ username: "carl" });
    dora = await generateUser({ username: "dora" });
    stranger = await generateUser({ username: "fremd" });

    // my list with bert and carl
    const mine = await createList(me.userId, "Meine");
    await addMember(mine.listId, bert.userId);
    await addMember(mine.listId, carl.userId, "editor");
    // anna's list with me and carl (carl a second time) and dora
    const annas = await createList(anna.userId, "Annas");
    await addMember(annas.listId, me.userId);
    await addMember(annas.listId, carl.userId);
    await addMember(annas.listId, dora.userId);
    // a list I am not in
    const foreign = await createList(stranger.userId, "Fremd");
    await addMember(foreign.listId, bert.userId);
  });

  it("should return owners, members and co-members once each, without myself and without e-mail", async () => {
    const response = await contactsOf(me);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      { userId: anna.userId, username: "anna" },
      { userId: bert.userId, username: "bert" },
      { userId: carl.userId, username: "carl" },
      { userId: dora.userId, username: "dora" },
    ]);
  });

  it("should not return people of lists I am not in, nor former members", async () => {
    await db.delete(todoListMembers).where(and(eq(todoListMembers.userId, me.userId)));

    const response = await contactsOf(me);

    expect(response.body.map((contact: { username: string }) => contact.username)).toEqual(["bert", "carl"]);
  });

  it("should return only the own contacts of an admin", async () => {
    const admin = await generateUser();

    const response = await contactsOf(admin, { role: "admin" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it("should need todo-lists:share", async () => {
    const response = await contactsOf(me, { permissions: ["todo-lists:read"] });

    expect(response.status).toBe(403);
  });

  it("should be registered in the app", () => {
    expect(readFileSync("src/index.ts", "utf8")).toContain("new TodoListContactAPI()");
  });
});
