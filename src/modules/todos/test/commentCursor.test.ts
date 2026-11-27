import { describe, it, expect } from "vitest";
import { decodeCommentCursor, encodeCommentCursor } from "../commentCursor";

describe("commentCursor", () => {
  it("should round-trip a cursor with microseconds", () => {
    const cursor = { createdAt: "2026-11-27 10:00:00.123456", commentId: "3f2a5b1e-0000-4000-8000-000000000001" };
    expect(decodeCommentCursor(encodeCommentCursor(cursor))).toEqual(cursor);
  });

  it.each([
    "",
    "abc",
    Buffer.from("[1,2]").toString("base64url"),
    Buffer.from('["kein datum","3f2a5b1e-0000-4000-8000-000000000001"]').toString("base64url"),
  ])("should reject the malformed cursor %j", (value) => {
    expect(decodeCommentCursor(value)).toBeUndefined();
  });
});
