import { db } from "@/db";
import { BaseModule } from "../core/BaseModule";
import { NewTodoComment, TodoComment, todoComments, UpdateTodoComment } from "./schema/todo.comment.schema";
import { desc, eq } from "drizzle-orm";

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
