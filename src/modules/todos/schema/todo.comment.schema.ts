import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { todos } from "./todo.schema";
import { users } from "@/db/schema";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import z from "zod";

export const todoComments = pgTable("todo_comments", {
  commentId: uuid("comment_id").defaultRandom().primaryKey(),
  todoId: uuid("todo_id")
    .notNull()
    .references(() => todos.todoId, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.userId, { onDelete: "cascade" }),
  comment: text("comment").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

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
  Omit<typeof todoComments.$inferInsert, "commentId" | "userId" | "createdAt" | "updatedAt">
>;

// Schemas for TypeScript
export const InsertTodoCommentSchema = createInsertSchema(todoComments, {
  comment: z.string().min(1, "Comment is required"),
});

export const SelectTodoCommentSchema = createSelectSchema(todoComments);

export const createTodoCommentSchema = z.object({
  commentRecord: InsertTodoCommentSchema.omit({
    commentId: true,
    userId: true,
    createdAt: true,
    updatedAt: true,
  }),
});

export const todoCommentByIdSchema = z.object({
  commentId: z.uuid("Invalid CommentId"),
});

export const updateTodoCommentSchema = z.object({
  updates: InsertTodoCommentSchema.omit({
    commentId: true,
    userId: true,
    todoId: true,
    createdAt: true,
    updatedAt: true,
  }).partial(),
});

export type InsertTodoComment = z.infer<typeof InsertTodoCommentSchema>;
export type SelectTodoComment = z.infer<typeof SelectTodoCommentSchema>;

export type CreateTodoCommentBody = z.infer<typeof createTodoCommentSchema>;
export type UpdateTodoCommentBody = z.infer<typeof updateTodoCommentSchema>;
export type TodoCommentByIdParams = z.infer<typeof todoCommentByIdSchema>;
