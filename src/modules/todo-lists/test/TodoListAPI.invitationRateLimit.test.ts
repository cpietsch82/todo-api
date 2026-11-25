import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import env from "../../../../env";
import { db } from "@/db";
import type { User } from "@/db/schema";
import { todoLists } from "@modules/todo-lists/schema/todo-list.schema";
import { TodoListAPI } from "@modules/todo-lists/TodoListAPI";
import { createAuthHeader, generateUser } from "@tests/test.helpers";
import { getTestServer } from "@tests/integration.setup";

async function createList(ownerId: string) {
  const [list] = await db.insert(todoLists).values({ name: "Einkauf", ownerId }).returning();
  return list;
}

describe("Rate limit of invitations", () => {
  let server: Server;

  const invite = async (owner: User, listId: string, username: string) =>
    request(server)
      .post(`/api/todo-lists/${listId}/invitations`)
      .set(await createAuthHeader(owner))
      .send({ username });

  beforeAll(() => {
    // the limiter reads the limit when the routes are created
    vi.spyOn(env, "INVITATION_RATE_LIMIT_MAX", "get").mockReturnValue(3);

    new TodoListAPI();
    server = getTestServer();
  });

  it("should block a user after 3 invitations per window, unknown usernames included", async () => {
    const owner = await generateUser();
    const invitee = await generateUser();
    const list = await createList(owner.userId);

    expect((await invite(owner, list.listId, "niemand1")).status).toBe(404);
    expect((await invite(owner, list.listId, "niemand2")).status).toBe(404);
    expect((await invite(owner, list.listId, invitee.username)).status).toBe(201);

    const blocked = await invite(owner, list.listId, "niemand3");

    expect(blocked.status).toBe(429);
    expect(blocked.text).toBe("Too many invitations, please try again later.");
  });

  it("should count per user, not per IP", async () => {
    const otherOwner = await generateUser();
    const invitee = await generateUser();
    const list = await createList(otherOwner.userId);

    expect((await invite(otherOwner, list.listId, invitee.username)).status).toBe(201);
  });
});
