import { db } from "@/db";
import { BaseModule } from "../core/BaseModule";
import { NewTodoComment, TodoComment, todoComments, UpdateTodoComment } from "./schema/todo.comment.schema";
import type { Todo } from "./schema/todo.schema";
import { and, asc, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { users } from "@/modules/users/schema/user.schema";
import { type CommentCursor, encodeCommentCursor } from "./commentCursor";
import { hasPermission } from "@/modules/authorization/permissions";
import type { AccessingUser } from "./TodoService";
import { TodoListService, type DbTransaction } from "@/modules/todo-lists/TodoListService";
import { resolveModule } from "@modules/core/resolveModule";
import { withRetryOnDeadlock } from "@/utils/dbErrors";

/** the parent of a reply does not exist, belongs to another todo or is deleted */
export class InvalidParentCommentError extends Error {
  constructor() {
    super("Invalid parent comment");
    this.name = "InvalidParentCommentError";
  }
}

/** the comment to remove does not exist (anymore), or is already a placeholder where only a whole thread may go */
export class CommentNotFoundError extends Error {
  constructor() {
    super("Comment not found");
    this.name = "CommentNotFoundError";
  }
}

/** what a deletion did: soft = placeholder, hard = row gone, branch = row gone with all its replies */
export interface CommentRemoval {
  commentId: string;
  mode: "soft" | "hard" | "branch";
  /**
   * the removed rows: the comment itself (not for soft) and the emptied placeholders above it, not the replies in a
   * branch
   */
  removedCommentIds: string[];
  /** branch only: the comment and its replies on all levels */
  removedCount?: number;
}

/** a comment in the discussion of a todo; deleted ones stay as placeholders, without text and author */
export interface DiscussionComment {
  commentId: string;
  todoId: string;
  parentCommentId: string | null;
  comment: string | null;
  createdAt: Date;
  updatedAt: Date;
  edited: boolean;
  deleted: boolean;
  /** direct replies, including placeholders */
  replyCount: number;
  /** only public fields of the author, no e-mail */
  author: { userId: string; username: string } | null;
}

export interface CommentPage {
  items: DiscussionComment[];
  nextCursor: string | null;
  total: number;
}

export interface DiscussionPage extends CommentPage {
  lastCommentAt: Date | null;
}

interface PageParams {
  limit: number;
  before?: CommentCursor;
}

export class TodoCommentService extends BaseModule {
  public static instance: TodoCommentService;
  protected todoListService: TodoListService;

  constructor() {
    super("todoComment.service", "Business logic for Todo Comment management");
    this.todoListService = resolveModule(TodoListService);

    if (!TodoCommentService.instance) {
      TodoCommentService.instance = this;
    }
    return TodoCommentService.instance;
  }

  async getAllTodoComments(): Promise<TodoComment[]> {
    return db.select().from(todoComments).orderBy(desc(todoComments.createdAt));
  }

  async getAllTodoCommentsForUser(userId: string): Promise<TodoComment[]> {
    return db.select().from(todoComments).where(eq(todoComments.userId, userId)).orderBy(desc(todoComments.createdAt));
  }

  async getTodoCommentById(commentId: string): Promise<TodoComment | undefined> {
    const [todoComment] = await db.select().from(todoComments).where(eq(todoComments.commentId, commentId)).limit(1);
    return todoComment;
  }

  /**
   * The newest top-level comments of a todo, oldest first, so it reads like a conversation. total and lastCommentAt
   * count the comments of all levels without the deleted ones.
   * The caller has to check first that the user may see the todo (requireTodoAccess).
   */
  async getDiscussionPage(todoId: string, page: PageParams): Promise<DiscussionPage> {
    const { items, nextCursor } = await this.queryCommentPage(
      and(eq(todoComments.todoId, todoId), isNull(todoComments.parentCommentId))!,
      page,
    );
    const [stats] = await db
      .select({
        total: sql<number>`count(*)::int`,
        // mapped like the timestamp column, otherwise the raw text would be read in the local time zone
        lastCommentAt: sql<Date | null>`max(${todoComments.createdAt})`.mapWith((value: string | null) =>
          value === null ? null : (todoComments.createdAt.mapFromDriverValue(value) as Date),
        ),
      })
      .from(todoComments)
      .where(and(eq(todoComments.todoId, todoId), isNull(todoComments.deletedAt)));

    return { items, nextCursor, total: stats.total, lastCommentAt: stats.lastCommentAt };
  }

  async getDiscussionComment(commentId: string): Promise<DiscussionComment | undefined> {
    const { items } = await this.queryCommentPage(eq(todoComments.commentId, commentId), { limit: 1 });
    return items[0];
  }

  /** newest first by (created_at, comment_id), one more than limit to know whether there are older ones */
  private async queryCommentPage(
    where: SQL,
    page: PageParams,
  ): Promise<{ items: DiscussionComment[]; nextCursor: string | null }> {
    const olderThanCursor = page.before
      ? sql`(${todoComments.createdAt}, ${todoComments.commentId}) < (${page.before.createdAt}::timestamp, ${page.before.commentId}::uuid)`
      : undefined;

    const rows = await db
      .select({
        commentId: todoComments.commentId,
        todoId: todoComments.todoId,
        parentCommentId: todoComments.parentCommentId,
        comment: todoComments.comment,
        createdAt: todoComments.createdAt,
        updatedAt: todoComments.updatedAt,
        deletedAt: todoComments.deletedAt,
        // the text keeps the microseconds, which a JS Date would lose
        // independent of the DateStyle of the server, always six digits of fraction
        createdAtText: sql<string>`to_char(${todoComments.createdAt}, 'YYYY-MM-DD HH24:MI:SS.US')`,
        // the alias is required: without it the correlated reference binds to the inner table and the count is always
        // 0 (Drizzle's alias() produced invalid SQL here)
        replyCount: sql<number>`(SELECT count(*) FROM todo_comments AS replies WHERE replies.parent_comment_id = ${todoComments.commentId})::int`,
        authorId: users.userId,
        authorUsername: users.username,
      })
      .from(todoComments)
      .leftJoin(users, eq(todoComments.userId, users.userId))
      .where(and(where, olderThanCursor))
      .orderBy(desc(todoComments.createdAt), desc(todoComments.commentId))
      .limit(page.limit + 1);

    const hasMore = rows.length > page.limit;
    const kept = hasMore ? rows.slice(0, page.limit) : rows;
    const oldest = kept[kept.length - 1];
    const nextCursor =
      hasMore && oldest ? encodeCommentCursor({ createdAt: oldest.createdAtText, commentId: oldest.commentId }) : null;

    const items = kept.map((row): DiscussionComment => {
      const deleted = row.deletedAt !== null;
      return {
        commentId: row.commentId,
        todoId: row.todoId,
        parentCommentId: row.parentCommentId,
        comment: deleted ? null : row.comment,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        // a placeholder does not reveal that the deleted comment had been edited
        edited: !deleted && row.updatedAt > row.createdAt,
        deleted,
        replyCount: row.replyCount,
        author:
          deleted || row.authorId === null ? null : { userId: row.authorId, username: row.authorUsername! },
      };
    });

    return { items: items.reverse(), nextCursor };
  }

  /**
   * Who moderates the discussion of a todo: an admin, the owner of the list for a todo in a list, the creator for a
   * todo without list. Only they may remove a whole thread, with the replies of others.
   */
  async canModerateComment(todo: Pick<Todo, "userId" | "listId">, user: AccessingUser): Promise<boolean> {
    if (hasPermission(user.permissions, "admin:all")) return true;
    if (!todo.listId) return todo.userId === user.id;

    const list = await this.todoListService.getListById(todo.listId);
    return list !== undefined && (await this.todoListService.getListRole(list, user)) === "owner";
  }

  /**
   * Who may remove a comment from a discussion (placeholder rule): its author and whoever moderates the discussion.
   * Changing the text stays with the author, nobody should be able to put words into someone else's mouth.
   */
  async canDeleteComment(
    comment: Pick<TodoComment, "userId">,
    todo: Pick<Todo, "userId" | "listId">,
    user: AccessingUser,
  ): Promise<boolean> {
    return comment.userId === user.id || this.canModerateComment(todo, user);
  }

  /** direct replies of a comment, also below a placeholder; total counts the direct replies */
  async getRepliesPage(commentId: string, page: PageParams): Promise<CommentPage> {
    const { items, nextCursor } = await this.queryCommentPage(eq(todoComments.parentCommentId, commentId), page);
    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(todoComments)
      .where(eq(todoComments.parentCommentId, commentId));
    return { items, nextCursor, total };
  }

  async createTodoComment(data: NewTodoComment): Promise<DiscussionComment | undefined> {
    let commentId: string;

    if (data.parentCommentId) {
      const parentCommentId = data.parentCommentId;
      commentId = await withRetryOnDeadlock(() =>
        db.transaction(async (tx) => {
          // FOR SHARE: a concurrent delete of the parent (soft or hard) waits until the reply is in
          const [parent] = await tx
            .select({ todoId: todoComments.todoId, deletedAt: todoComments.deletedAt })
            .from(todoComments)
            .where(eq(todoComments.commentId, parentCommentId))
            .for("share");
          if (!parent || parent.todoId !== data.todoId || parent.deletedAt !== null) {
            throw new InvalidParentCommentError();
          }
          const [created] = await tx.insert(todoComments).values(data).returning({ commentId: todoComments.commentId });
          return created.commentId;
        }),
      );
    } else {
      const [created] = await db.insert(todoComments).values(data).returning({ commentId: todoComments.commentId });
      commentId = created.commentId;
    }

    // undefined only when the comment was deleted right after it was written
    return this.getDiscussionComment(commentId);
  }

  /** undefined when the comment is gone or a placeholder (deleted meanwhile): its text must not come back */
  async updateTodoComment(commentId: string, updateData: UpdateTodoComment): Promise<DiscussionComment | undefined> {
    const [current] = await db
      .select({ comment: todoComments.comment })
      .from(todoComments)
      .where(and(eq(todoComments.commentId, commentId), isNull(todoComments.deletedAt)));
    if (!current) return undefined;
    // the same text again is no edit
    if (updateData.comment === undefined || updateData.comment === current.comment) {
      return this.getDiscussionComment(commentId);
    }

    const updated = await db
      .update(todoComments)
      .set({ ...updateData, updatedAt: new Date() })
      .where(and(eq(todoComments.commentId, commentId), isNull(todoComments.deletedAt)))
      .returning({ commentId: todoComments.commentId });
    if (updated.length === 0) return undefined;

    return this.getDiscussionComment(commentId);
  }

  /**
   * Deletes a comment by the placeholder rule: with replies it stays as a placeholder without text, otherwise it is
   * deleted for good, and so are the placeholders above it that have no replies left.
   * @param tx the running transaction (e.g. the deletion of an account), otherwise an own one is used
   * @throws CommentNotFoundError when the comment does not exist or already is a placeholder
   */
  async removeComment(commentId: string, tx?: DbTransaction): Promise<CommentRemoval> {
    // an own transaction is retried after a deadlock; a given one belongs to the caller, who decides on retrying
    if (!tx) {
      return withRetryOnDeadlock(() => db.transaction((ownTx) => this.removeComment(commentId, ownTx)));
    }

    // lock order: the comment first, then its parents upwards (cleanUpEmptyPlaceholders); a reply written meanwhile
    // holds the comment FOR SHARE, so the count below sees it
    const comment = await this.lockComment(tx, commentId);
    if (!comment || comment.deletedAt !== null) throw new CommentNotFoundError();

    if ((await this.countReplies(tx, commentId)) > 0) {
      await tx
        .update(todoComments)
        .set({ deletedAt: sql`now()`, comment: null })
        .where(eq(todoComments.commentId, commentId));
      return { commentId, mode: "soft", removedCommentIds: [] };
    }

    await tx.delete(todoComments).where(eq(todoComments.commentId, commentId));
    const cleanedUp = await this.cleanUpEmptyPlaceholders(tx, comment.parentCommentId);
    return { commentId, mode: "hard", removedCommentIds: [commentId, ...cleanedUp] };
  }

  /**
   * Removes all live comments of a user by the placeholder rule (for the deletion of an account), so that replies of
   * others survive below a placeholder without author. Runs in the transaction of the caller and locks the comments
   * ordered by id, after user, lists and todos (lock order of the spec).
   * No skipping or error handling is needed: all rows are locked in this transaction, and the cleanup of a hard delete
   * only removes placeholders, which an own comment becomes only after it was processed itself.
   */
  async removeCommentsOfUser(userId: string, tx: DbTransaction): Promise<void> {
    const own = await tx
      .select({ commentId: todoComments.commentId })
      .from(todoComments)
      .where(and(eq(todoComments.userId, userId), isNull(todoComments.deletedAt)))
      .orderBy(asc(todoComments.commentId))
      .for("update");

    for (const { commentId } of own) await this.removeComment(commentId, tx);
  }

  /**
   * Deletes a comment (also a placeholder) for good together with its replies on all levels (foreign key cascade),
   * then the placeholders above it that have no replies left. Only for moderators.
   * @throws CommentNotFoundError when the comment does not exist (anymore)
   */
  async removeBranch(commentId: string): Promise<CommentRemoval> {
    return withRetryOnDeadlock(() =>
      db.transaction(async (tx) => {
        const comment = await this.lockComment(tx, commentId);
        if (!comment) throw new CommentNotFoundError();

        // a scalar subquery around the recursive count: the builder maps the result the same way for every driver
        const [{ removed }] = await tx
          .select({
            removed: sql<number>`(
              WITH RECURSIVE branch AS (
                SELECT comment_id FROM todo_comments WHERE comment_id = ${commentId}
                UNION ALL
                SELECT c.comment_id FROM todo_comments c JOIN branch b ON c.parent_comment_id = b.comment_id
              ) SELECT count(*)::int AS removed FROM branch
            )`,
          })
          .from(todoComments)
          .where(eq(todoComments.commentId, commentId));

        await tx.delete(todoComments).where(eq(todoComments.commentId, commentId));
        const cleanedUp = await this.cleanUpEmptyPlaceholders(tx, comment.parentCommentId);
        return { commentId, mode: "branch", removedCommentIds: [commentId, ...cleanedUp], removedCount: removed };
      }),
    );
  }

  private async lockComment(
    tx: DbTransaction,
    commentId: string,
  ): Promise<Pick<TodoComment, "parentCommentId" | "deletedAt"> | undefined> {
    const [comment] = await tx
      .select({ parentCommentId: todoComments.parentCommentId, deletedAt: todoComments.deletedAt })
      .from(todoComments)
      .where(eq(todoComments.commentId, commentId))
      .for("update");
    return comment;
  }

  private async countReplies(tx: DbTransaction, commentId: string): Promise<number> {
    const [{ replies }] = await tx
      .select({ replies: sql<number>`count(*)::int` })
      .from(todoComments)
      .where(eq(todoComments.parentCommentId, commentId));
    return replies;
  }

  /**
   * Deletes the parent when it is a placeholder without replies, and so on upwards, each one locked before it is
   * looked at. A placeholder nobody answers anymore has nothing left to show.
   * @returns the ids of the deleted placeholders, nearest first
   */
  private async cleanUpEmptyPlaceholders(tx: DbTransaction, parentCommentId: string | null): Promise<string[]> {
    const removed: string[] = [];
    let currentId = parentCommentId;

    while (currentId) {
      const parent = await this.lockComment(tx, currentId);
      if (!parent || parent.deletedAt === null || (await this.countReplies(tx, currentId)) > 0) break;

      await tx.delete(todoComments).where(eq(todoComments.commentId, currentId));
      removed.push(currentId);
      currentId = parent.parentCommentId;
    }

    return removed;
  }
}

export default TodoCommentService;
