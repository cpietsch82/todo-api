import { db } from "@/db";
import { BaseModule } from "../core/BaseModule";
import { NewTodoComment, TodoComment, todoComments, UpdateTodoComment } from "./schema/todo.comment.schema";
import type { Todo } from "./schema/todo.schema";
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { users } from "@/modules/users/schema/user.schema";
import { type CommentCursor, encodeCommentCursor } from "./commentCursor";
import { hasPermission } from "@/modules/authorization/permissions";
import type { AccessingUser } from "./TodoService";
import { TodoListService } from "@/modules/todo-lists/TodoListService";
import { resolveModule } from "@modules/core/resolveModule";

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
        createdAtText: sql<string>`${todoComments.createdAt}::text`,
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
        edited: row.updatedAt > row.createdAt,
        deleted,
        replyCount: row.replyCount,
        author:
          deleted || row.authorId === null ? null : { userId: row.authorId, username: row.authorUsername! },
      };
    });

    return { items: items.reverse(), nextCursor };
  }

  /**
   * Who may remove a comment from a discussion: its author, an admin, and whoever moderates the discussion: the owner
   * of the list for a todo in a list, the creator for a todo without list. Changing the text stays with the author,
   * nobody should be able to put words into someone else's mouth.
   */
  async canDeleteComment(
    comment: Pick<TodoComment, "userId">,
    todo: Pick<Todo, "userId" | "listId">,
    user: AccessingUser,
  ): Promise<boolean> {
    if (hasPermission(user.permissions, "admin:all") || comment.userId === user.id) return true;
    if (!todo.listId) return todo.userId === user.id;

    const list = await this.todoListService.getListById(todo.listId);
    return list !== undefined && (await this.todoListService.getListRole(list, user)) === "owner";
  }

  async createTodoComment(data: NewTodoComment): Promise<TodoComment> {
    const [todoComment] = await db.insert(todoComments).values(data).returning();
    return todoComment;
  }

  async updateTodoComment(commentId: string, updateData: UpdateTodoComment): Promise<TodoComment> {
    const [todoComment] = await db
      .update(todoComments)
      .set(updateData)
      .where(eq(todoComments.commentId, commentId))
      .returning();

    return todoComment;
  }

  async deleteTodoComment(commentId: string): Promise<TodoComment> {
    const [todoComment] = await db.delete(todoComments).where(eq(todoComments.commentId, commentId)).returning();
    return todoComment;
  }
}

export default TodoCommentService;
