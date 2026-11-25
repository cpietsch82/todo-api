import { check, index, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { users } from "@/modules/users/schema/user.schema";
import { NO_CONTROL_CHARACTERS } from "@/utils/textPatterns";

// Roles of the members of a list. The owner is not a member, the list itself names it (todo_lists.owner_id), so a
// list always has exactly one owner.
export const todoListRoleEnum = pgEnum("todo_list_role", ["editor", "viewer"]);

export const todoLists = pgTable(
  "todo_lists",
  {
    listId: uuid("list_id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description"),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("idx_todo_lists_owner_id").on(table.ownerId)],
);

export const todoListMembers = pgTable(
  "todo_list_members",
  {
    listId: uuid("list_id")
      .notNull()
      .references(() => todoLists.listId, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    role: todoListRoleEnum("role").notNull(),
    // who added the member, kept when that user is deleted
    addedBy: uuid("added_by").references(() => users.userId, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.listId, table.userId] }),
    index("idx_todo_list_members_user_id").on(table.userId),
  ],
);

/**
 * An open invitation to a list: either for a user (invitee_id, invitation by username) or, later, for whoever opens
 * an invitation link (token_hash, the sha256 of the token). Exactly one of both is set.
 */
export const todoListInvitations = pgTable(
  "todo_list_invitations",
  {
    invitationId: uuid("invitation_id").defaultRandom().primaryKey(),
    listId: uuid("list_id")
      .notNull()
      .references(() => todoLists.listId, { onDelete: "cascade" }),
    inviteeId: uuid("invitee_id").references(() => users.userId, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).unique(),
    role: todoListRoleEnum("role").default("viewer").notNull(),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [
    check("chk_todo_list_invitations_target", sql`(${table.inviteeId} IS NULL) <> (${table.tokenHash} IS NULL)`),
    uniqueIndex("uq_todo_list_invitations_list_invitee")
      .on(table.listId, table.inviteeId)
      .where(sql`${table.inviteeId} IS NOT NULL`),
  ],
);

// Types for TypeScript
export type TodoList = typeof todoLists.$inferSelect;
export type NewTodoList = Omit<typeof todoLists.$inferInsert, "listId" | "createdAt" | "updatedAt">;
export type TodoListMember = typeof todoListMembers.$inferSelect;
export type TodoListInvitation = typeof todoListInvitations.$inferSelect;
export type MemberRole = (typeof todoListRoleEnum.enumValues)[number];
/** the role of a user in a list, the owner included */
export type ListRole = "owner" | MemberRole;

// API Request Schemas
const listNameSchema = z
  .string()
  .trim()
  .normalize("NFC")
  .min(1, "Name is required")
  .max(100, "Name must not be longer than 100 characters")
  .regex(NO_CONTROL_CHARACTERS, "Name must not contain control characters");

const listDescriptionSchema = z
  .string()
  .trim()
  .max(1000, "Description must not be longer than 1000 characters")
  .nullable()
  .optional();

export const todoListByIdSchema = z.object({
  listId: z.uuid("Invalid ListId"),
});

export const createTodoListSchema = z.object({
  listRecord: z.object({
    name: listNameSchema,
    description: listDescriptionSchema,
  }),
});

export const updateTodoListSchema = z.object({
  updates: z.object({
    name: listNameSchema.optional(),
    description: listDescriptionSchema,
  }),
});

export type TodoListByIdParams = z.infer<typeof todoListByIdSchema>;
export type CreateTodoListBody = z.infer<typeof createTodoListSchema>;
export type UpdateTodoListBody = z.infer<typeof updateTodoListSchema>;
