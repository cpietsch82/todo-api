import { db } from "@/db";
import { BaseModule } from "../core/BaseModule";
import { NewTodoComment, TodoComment, todoComments, UpdateTodoComment } from "./schema/todo.comment.schema";
import type { Todo } from "./schema/todo.schema";
import { users } from "@/modules/users/schema/user.schema";
import { asc, desc, eq } from "drizzle-orm";
import { hasPermission } from "@/modules/authorization/permissions";
import type { AccessingUser } from "./TodoService";

/** a comment as part of the discussion of a todo, with the author, so the others see who wrote it */
export interface TodoDiscussionComment {
  commentId: string;
  todoId: string;
  comment: string;
  createdAt: Date;
  updatedAt: Date;
  /** only public fields of the author, no e-mail */
  author: { userId: string; username: string };
}

export class TodoCommentService extends BaseModule {
  public static instance: TodoCommentService;

  constructor() {
    super("todoComment.service", "Business logic for Todo Comment management");

    if (!TodoCommentService.instance) {
      TodoCommentService.instance = this;
    }
    return TodoCommentService.instance;
  }

  public async getAllTodoComments(): Promise<TodoComment[]> {
    return db.select().from(todoComments).orderBy(desc(todoComments.createdAt));
  }

  public async getAllTodoCommentsForUser(userId: string): Promise<TodoComment[]> {
    return db.select().from(todoComments).where(eq(todoComments.userId, userId)).orderBy(desc(todoComments.createdAt));
  }

  public async getTodoCommentById(commentId: string): Promise<TodoComment | undefined> {
    const [todoComment] = await db.select().from(todoComments).where(eq(todoComments.commentId, commentId)).limit(1);
    return todoComment;
  }

  /**
   * The discussion of a todo: the comments of all users, oldest first, so it reads like a conversation.
   * The caller has to check first that the user may see the todo (requireTodoAccess).
   *
   * TODO(discussion): not used yet. Will serve GET /api/todos/:todoId/comments (guarded by requireTodoAccess) once
   * todos can be shared. Today GET /todo-comments only returns the own comments, so the others would not see them.
   */
  public async getCommentsForTodo(todoId: string): Promise<TodoDiscussionComment[]> {
    const rows = await db
      .select({
        commentId: todoComments.commentId,
        todoId: todoComments.todoId,
        comment: todoComments.comment,
        createdAt: todoComments.createdAt,
        updatedAt: todoComments.updatedAt,
        authorId: users.userId,
        authorUsername: users.username,
      })
      .from(todoComments)
      .innerJoin(users, eq(todoComments.userId, users.userId))
      .where(eq(todoComments.todoId, todoId))
      .orderBy(asc(todoComments.createdAt), asc(todoComments.commentId));

    return rows.map(({ authorId, authorUsername, ...comment }) => ({
      ...comment,
      author: { userId: authorId, username: authorUsername },
    }));
  }

  /**
   * Who may remove a comment from a discussion: its author, an admin, and the creator of the todo, who moderates
   * the discussion of the own todo. Changing the text stays with the author (requireTodoCommentOwnership), nobody
   * should be able to put words into someone else's mouth.
   *
   * TODO(discussion): not used yet. Will replace requireTodoCommentOwnership on DELETE /api/todo-comments/:commentId
   * once other users can comment on a todo; today all comments of a todo come from its creator (or an admin).
   */
  public canDeleteComment(comment: Pick<TodoComment, "userId">, todo: Pick<Todo, "userId">, user: AccessingUser): boolean {
    if (hasPermission(user.permissions, "admin:all")) return true;
    return comment.userId === user.id || todo.userId === user.id;
  }

  public async createTodoComment(data: NewTodoComment): Promise<TodoComment> {
    const [todoComment] = await db.insert(todoComments).values(data).returning();
    return todoComment;
  }

  public async updateTodoComment(commentId: string, updateData: UpdateTodoComment): Promise<TodoComment> {
    const [todoComment] = await db
      .update(todoComments)
      .set(updateData)
      .where(eq(todoComments.commentId, commentId))
      .returning();

    return todoComment;
  }

  public async deleteTodoComment(commentId: string): Promise<TodoComment> {
    const [todoComment] = await db.delete(todoComments).where(eq(todoComments.commentId, commentId)).returning();
    return todoComment;
  }
}

export default TodoCommentService;
