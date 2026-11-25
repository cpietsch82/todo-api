import { pgTable, uuid, varchar, timestamp, check, uniqueIndex } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { todos } from "@/modules/todos/schema/todo.schema";
import { createInsertSchema } from "drizzle-zod";
import z from "zod";
import { NO_CONTROL_CHARACTERS } from "@/utils/textPatterns";
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
export const emailSchema = z.string().trim().toLowerCase().max(255).pipe(z.email("Invalid e-mail format"));

// Latin letters (including umlauts and accents), digits and . _ -
// Other scripts are left out on purpose: a cyrillic "а" looks like a latin "a", so "аdmin" could pose as "admin" where
// the username is shown to others (e.g. as author of a comment). The login uses the e-mail, so this is about display.
const USERNAME_PATTERN = /^[\p{Script=Latin}0-9._-]+$/u;

/**
 * A username as it is stored. NFKC brings every way of writing the same character into one form ("ü" as one character
 * or as "u" + combining diaeresis, full width "ａ" and "a"), otherwise the unique index could hold the same visible
 * name twice. The spelling (case) is kept, uniqueness regardless of case is ensured by the database.
 */
export const usernameSchema = z
  .string()
  .trim()
  .normalize("NFKC")
  .min(3, "Username must have at least 3 characters")
  .max(50, "Username must not be longer than 50 characters")
  .regex(USERNAME_PATTERN, "Username may only contain latin letters, digits, dot, underscore and hyphen");


/** First or last name: any script, trimmed, at most 50 characters; an empty name is stored as null. */
const personNameSchema = z
  .string()
  .trim()
  .normalize("NFC")
  .max(50, "Must not be longer than 50 characters")
  .regex(NO_CONTROL_CHARACTERS, "Must not contain control characters")
  .transform((name) => name || null)
  .optional();

export const InsertUserSchema = createInsertSchema(users, {
  email: emailSchema,
  username: usernameSchema,
  firstName: personNameSchema,
  lastName: personNameSchema,
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
