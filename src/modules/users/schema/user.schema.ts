import { pgTable, uuid, varchar, timestamp } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { todos } from "@/modules/todos/schema/todo.schema";
import { createInsertSchema } from "drizzle-zod";
import z from "zod";
import { authentications } from "@/db/schema";

// DB Schema
export const users = pgTable("users", {
  userId: uuid("user_id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  username: varchar("username", { length: 50 }).notNull().unique(),
  firstName: varchar("first_name", { length: 50 }),
  lastName: varchar("last_name", { length: 50 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Relations (für Joins)
export const usersRelations = relations(users, ({ one, many }) => ({
  authentication: one(authentications, {
    fields: [users.userId],
    references: [authentications.userId],
  }),
  todos: many(todos),
}));

// Types für TypeScript
export type User = typeof users.$inferSelect;
export type NewUser = Omit<typeof users.$inferInsert, "userId" | "createdAt" | "updatedAt">;
export type UpdateUser = Partial<Omit<typeof users.$inferInsert, "userId" | "createdAt" | "updatedAt">>;

export const InsertUserSchema = createInsertSchema(users, {
  email: z.email("Invalid e-mail format"),
  username: z.string(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
});

export const createUserSchema = z.object({
  userRecord: InsertUserSchema.omit({
    userId: true,
    createdAt: true,
    updatedAt: true,
  }),
});

export const userByIdSchema = z.object({
  userId: z.uuid("Invalid UserId"),
});

export const updateUserSchema = z.object({
  updates: InsertUserSchema.omit({
    userId: true,
    createdAt: true,
    updatedAt: true,
  }).partial(),
});

export type InsertUser = z.infer<typeof InsertUserSchema>;
export type CreateUserBody = z.infer<typeof createUserSchema>;
export type UpdateUserBody = z.infer<typeof updateUserSchema>;
export type UserByIdParams = z.infer<typeof userByIdSchema>;
