import { db } from "@/db";
import { BaseModule } from "../core/BaseModule";
import { NewTodoComment, TodoComment, todoComments, UpdateTodoComment } from "./schema/todo.comment.schema";
import type { Todo } from "./schema/todo.schema";
import { users } from "@/modules/users/schema/user.schema";
import { asc, desc, eq } from "drizzle-orm";
import { hasPermission } from "@/modules/authorization/permissions";
import type { AccessingUser } from "./TodoService";
import { TodoListService } from "@/modules/todo-lists/TodoListService";
import { resolveModule } from "@modules/core/resolveModule";

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
   * The discussion of a todo: the comments of all users, oldest first, so it reads like a conversation.
   * The caller has to check first that the user may see the todo (requireTodoAccess).
   */
  async getCommentsForTodo(todoId: string): Promise<TodoDiscussionComment[]> {
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

    return rows.map(({ authorId, authorUsername, comment, ...rest }) => ({
      ...rest,
      comment: comment ?? "",
      author: { userId: authorId, username: authorUsername },
    }));
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
