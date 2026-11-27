import { z } from "zod";

/** position in the discussion: createdAt is the text of created_at::text (microseconds), a JS Date would lose them */
export interface CommentCursor {
  createdAt: string;
  commentId: string;
}

export const encodeCommentCursor = (cursor: CommentCursor): string =>
  Buffer.from(JSON.stringify([cursor.createdAt, cursor.commentId])).toString("base64url");

export function decodeCommentCursor(value: string): CommentCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
    const [createdAt, commentId] = parsed;
    if (typeof createdAt !== "string" || typeof commentId !== "string") return undefined;
    if (!z.uuid().safeParse(commentId).success) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/.test(createdAt) || Number.isNaN(Date.parse(createdAt))) {
      return undefined;
    }
    return { createdAt, commentId };
  } catch {
    return undefined;
  }
}
