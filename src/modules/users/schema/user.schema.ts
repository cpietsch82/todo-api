import { pgTable, uuid, varchar, timestamp, check, uniqueIndex } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { todos } from "@/modules/todos/schema/todo.schema";
import { createInsertSchema } from "drizzle-zod";
import z from "zod";
import { authentications } from "@/db/schema";

// DB Schema
// The e-mail is stored in lowercase (see emailSchema), so the unique constraint also covers other spellings.
// The username keeps its spelling for display, but may only exist once regardless of case ("Max" and "max").
export const users = pgTable(
  "users",
  {
    userId: uuid("user_id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    username: varchar("username", { length: 50 }).notNull().unique(),
    firstName: varchar("first_name", { length: 50 }),
    lastName: varchar("last_name", { length: 50 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check("chk_users_email_lowercase", sql`${table.email} = lower(${table.email})`),
    uniqueIndex("uq_users_username_lower").on(sql`lower(${table.username})`),
  ],
);

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

/**
 * An e-mail as it is stored and looked up: without surrounding whitespace and in lowercase, validated afterwards.
 * Use it for every e-mail that comes in, otherwise "Max@x.de" and "max@x.de" would be different accounts.
 */
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email("Invalid e-mail format"));

export const InsertUserSchema = createInsertSchema(users, {
  email: emailSchema,
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
