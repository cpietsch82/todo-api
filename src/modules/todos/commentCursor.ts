import { z } from "zod";

/** position in the discussion: createdAt is the text of created_at::text (microseconds), a JS Date would lose them */
export interface CommentCursor {
  createdAt: string;
  commentId: string;
}

export const encodeCommentCursor = (cursor: CommentCursor): string =>
  Buffer.from(JSON.stringify([cursor.createdAt, cursor.commentId])).toString("base64url");

/** Date.parse accepts impossible dates like 2026-02-30, so the components are checked against Date.UTC */
function isValidTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?$/.exec(value);
  if (!match) return false;
  const [y, mo, d, h, mi, sec] = match.slice(1).map(Number);
  if (y < 1) return false;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d &&
    date.getUTCHours() === h &&
    date.getUTCMinutes() === mi &&
    date.getUTCSeconds() === sec
  );
}

export function decodeCommentCursor(value: string): CommentCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
    const [createdAt, commentId] = parsed;
    if (typeof createdAt !== "string" || typeof commentId !== "string") return undefined;
    if (!z.uuid().safeParse(commentId).success) return undefined;
    if (!isValidTimestamp(createdAt)) return undefined;
    return { createdAt, commentId };
  } catch {
    return undefined;
  }
}
