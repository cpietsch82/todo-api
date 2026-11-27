import { type AnyPgColumn, check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { todos } from "./todo.schema";
import { users } from "@/db/schema";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import z from "zod";
import { type CommentCursor, decodeCommentCursor } from "../commentCursor";

export const todoComments = pgTable(
  "todo_comments",
  {
    commentId: uuid("comment_id").defaultRandom().primaryKey(),
    todoId: uuid("todo_id")
      .notNull()
      .references(() => todos.todoId, { onDelete: "cascade" }),
    parentCommentId: uuid("parent_comment_id").references((): AnyPgColumn => todoComments.commentId, {
      onDelete: "cascade",
    }),
    userId: uuid("user_id").references(() => users.userId, { onDelete: "set null" }),
    comment: text("comment"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check("todo_comments_text_unless_deleted", sql`${table.deletedAt} IS NOT NULL OR ${table.comment} IS NOT NULL`),
    check("todo_comments_author_unless_deleted", sql`${table.deletedAt} IS NOT NULL OR ${table.userId} IS NOT NULL`),
    index("idx_todo_comments_thread").on(
      table.todoId,
      table.parentCommentId,
      table.createdAt.desc(),
      table.commentId.desc(),
    ),
    index("idx_todo_comments_parent").on(table.parentCommentId),
  ],
);

export const todoCommentsRelations = relations(todoComments, ({ one }) => ({
  todo: one(todos, {
    fields: [todoComments.todoId],
    references: [todos.todoId],
  }),
  user: one(users, {
    fields: [todoComments.userId],
    references: [users.userId],
  }),
}));

// Types for TypeScript
export type TodoComment = typeof todoComments.$inferSelect;
export type NewTodoComment = Omit<typeof todoComments.$inferInsert, "commentId" | "createdAt" | "updatedAt">;
export type UpdateTodoComment = Partial<
  Omit<typeof todoComments.$inferInsert, "commentId" | "userId" | "parentCommentId" | "deletedAt" | "createdAt" | "updatedAt">
>;

// Schemas for TypeScript
export const InsertTodoCommentSchema = createInsertSchema(todoComments, {
  comment: z.string().min(1, "Comment is required").max(2000, "Comment is too long"),
});

export const SelectTodoCommentSchema = createSelectSchema(todoComments);

export const createTodoCommentSchema = z.object({
  commentRecord: InsertTodoCommentSchema.omit({
    commentId: true,
    userId: true,
    deletedAt: true,
    createdAt: true,
    updatedAt: true,
  }).extend({ parentCommentId: z.uuid().optional() }),
});

export const todoCommentByIdSchema = z.object({
  commentId: z.uuid("Invalid CommentId"),
});

// the text is the only editable field, so it is required: an empty update would only mark the comment as edited
export const updateTodoCommentSchema = z.object({
  updates: InsertTodoCommentSchema.omit({
    commentId: true,
    userId: true,
    todoId: true,
    parentCommentId: true,
    deletedAt: true,
    createdAt: true,
    updatedAt: true,
  }),
});

export const commentPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z
    .string()
    .transform((value, ctx): CommentCursor => {
      const cursor = decodeCommentCursor(value);
      if (!cursor) {
        ctx.addIssue({ code: "custom", message: "Invalid cursor" });
        return z.NEVER;
      }
      return cursor;
    })
    .optional(),
});

export type CommentPageQuery = z.infer<typeof commentPageQuerySchema>;

/** scope=branch: the comment with all its replies (moderators only); without scope the placeholder rule applies */
export const deleteCommentQuerySchema = z.object({
  scope: z.literal("branch").optional(),
});

export type DeleteCommentQuery = z.infer<typeof deleteCommentQuerySchema>;
export type InsertTodoComment = z.infer<typeof InsertTodoCommentSchema>;
export type SelectTodoComment = z.infer<typeof SelectTodoCommentSchema>;

export type CreateTodoCommentBody = z.infer<typeof createTodoCommentSchema>;
export type UpdateTodoCommentBody = z.infer<typeof updateTodoCommentSchema>;
export type TodoCommentByIdParams = z.infer<typeof todoCommentByIdSchema>;
