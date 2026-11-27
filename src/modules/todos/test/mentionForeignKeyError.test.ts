import { describe, expect, it } from "vitest";
import { InvalidMentionError, mapMentionForeignKeyError } from "../TodoCommentService";

const mentionUserFk = "todo_comment_mentions_user_id_users_user_id_fk";

describe("mapMentionForeignKeyError", () => {
  it("should turn the foreign key violation on the mentioned user into an InvalidMentionError", () => {
    // postgres-js style, wrapped like Drizzle does
    const error = new Error("Failed query", { cause: { code: "23503", constraint_name: mentionUserFk } });
    expect(() => mapMentionForeignKeyError(error)).toThrow(InvalidMentionError);
  });
  it("should also know the constraint name of PGlite", () => {
    expect(() => mapMentionForeignKeyError({ code: "23503", constraint: mentionUserFk })).toThrow(InvalidMentionError);
  });
  it("should rethrow a violation of another constraint unchanged", () => {
    const error = { code: "23503", constraint_name: "todo_comments_todo_id_todos_todo_id_fk" };
    let thrown: unknown;
    try {
      mapMentionForeignKeyError(error);
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toBe(error);
  });
  it("should rethrow any other error unchanged", () => {
    const error = new Error("boom");
    expect(() => mapMentionForeignKeyError(error)).toThrow(error);
  });
});
