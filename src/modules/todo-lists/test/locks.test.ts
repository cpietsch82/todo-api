import { describe, it, expect } from "vitest";
import { db } from "@/db";
import { todoLists } from "@modules/todo-lists/schema/todo-list.schema";
import { lockList, lockUsers } from "@modules/todo-lists/locks";
import { HttpError } from "@/utils/HttpError";
import { generateUser, NON_EXISTENT_UUID } from "@tests/test.helpers";

describe("locks of the todo lists", () => {
  it("should return the locked list", async () => {
    const owner = await generateUser();
    const [list] = await db.insert(todoLists).values({ name: "Einkauf", ownerId: owner.userId }).returning();

    const locked = await db.transaction((tx) => lockList(tx, list.listId, owner.userId));

    expect(locked).toEqual(list);
  });

  it("should throw 404 for a missing list and 409 for another owner", async () => {
    const owner = await generateUser();
    const other = await generateUser();
    const [list] = await db.insert(todoLists).values({ name: "Einkauf", ownerId: owner.userId }).returning();

    const missing = db.transaction((tx) => lockList(tx, NON_EXISTENT_UUID));
    const changed = db.transaction((tx) => lockList(tx, list.listId, other.userId));

    await expect(missing).rejects.toMatchObject({ status: 404, message: "List not found" });
    await expect(changed).rejects.toBeInstanceOf(HttpError);
    await expect(changed).rejects.toMatchObject({ status: 409, message: "The list changed meanwhile, please try again" });
  });

  it("should return the locked user ids without duplicates", async () => {
    const a = await generateUser();
    const b = await generateUser();
    const [first, second] = [a.userId, b.userId].sort();

    const locked = await db.transaction((tx) => lockUsers(tx, [second, first, first, NON_EXISTENT_UUID]));

    expect(locked).toEqual([first, second]);
  });
});
