import { pgTable, uuid, varchar, text, timestamp, index, pgEnum, integer, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "@/modules/users/schema/user.schema";
import { todoLists } from "@/modules/todo-lists/schema/todo-list.schema";

// DB Schema
export const todoStatusEnum = pgEnum("todo_status", ["in_progress", "finished", "declined", "not_ready", "blocked_by"]);
export const todoSeverityEnum = pgEnum("todo_severity", ["low", "medium", "high", "critical"]);

export const todos = pgTable(
  "todos",
  {
    todoId: uuid("todo_id").defaultRandom().primaryKey(),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    status: todoStatusEnum("status").default("not_ready"),
    severity: todoSeverityEnum("severity").default("medium"),
    tags: text("tags").array().default([]),
    // the creator; null once the creator is deleted while the todo stays in a list of someone else
    userId: uuid("user_id").references(() => users.userId, { onDelete: "set null" }),
    // the list the todo belongs to; deleting a list gives its todos back to their creators
    listId: uuid("list_id").references(() => todoLists.listId, { onDelete: "set null" }),
    // increased with every change, for the detection of concurrent changes (not used yet)
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    // Unix-Timestamp in Sekunden (BigInt)
    // created_at: bigint("created_at", { mode: 'number' })
    // .default(sql`extract(epoch from now())`)
    // .notNull(),
  },
  (table) => [
    index("idx_todos_user_id").on(table.userId),
    index("idx_todos_status").on(table.status),
    index("idx_todos_tags").on(table.tags),
    index("idx_todos_list_id").on(table.listId),
    // a todo without creator and without list would belong to nobody
    check("chk_todos_owner_or_list", sql`${table.userId} IS NOT NULL OR ${table.listId} IS NOT NULL`),
  ],
);

// Relations (for Joins)
export const todosRelations = relations(todos, ({ one }) => ({
  user: one(users, {
    fields: [todos.userId],
    references: [users.userId],
  }),
}));

// Types for TypeScript
export type Todo = typeof todos.$inferSelect;
export type NewTodo = Omit<typeof todos.$inferInsert, "todoId" | "createdAt" | "updatedAt">;
export type UpdateTodo = Partial<Omit<typeof todos.$inferInsert, "todoId" | "userId" | "createdAt" | "updatedAt">>;

export type TodoStatus = (typeof todoStatusEnum.enumValues)[number];

// API Request Schemas
export const InsertTodoSchema = createInsertSchema(todos, {
  title: z.string().min(5, "Too short!"),
  description: z.string(),
  tags: z.array(z.string()).max(10, "Max of 10 tags are allowed!"),
  status: z.enum(todoStatusEnum.enumValues),
});

export const SelectTodoSchema = createSelectSchema(todos);

export const createTodoSchema = z.object({
  todoRecord: InsertTodoSchema.omit({
    todoId: true,
    userId: true,
    createdAt: true,
    updatedAt: true,
    version: true,
  }).extend({
    // null or missing: the todo belongs to no list
    listId: z.uuid("Invalid ListId").nullable().optional(),
  }),
});

export const todoByIdSchema = z.object({
  todoId: z.uuid("Invalid TodoId"),
});

export const updateTodoSchema = z.object({
  // todoId: z.uuid("Invalid TodoId"),
  updates: InsertTodoSchema.omit({
    todoId: true,
    userId: true,
    createdAt: true,
    updatedAt: true,
    version: true,
  })
    .extend({
      // null takes the todo out of its list
      listId: z.uuid("Invalid ListId").nullable(),
    })
    .partial(),
});

// Schemas für spezielle Aktionen
// export const queryTodosSchema = z.object({
//   query: z
//     .object({
//       status: z.enum(todoStatusEnum.enumValues).optional(),
//       userId: z.uuid().optional(),
//       tags: z
//         .string()
//         .transform((str) =>
//           str
//             .split(",")
//             .map((s) => s.trim())
//             .filter(Boolean),
//         )
//         .optional(),
//       limit: z
//         .string()
//         .regex(/^\d+$/, "Limit muss eine Zahl sein")
//         .transform(Number)
//         .refine((n) => n >= 1 && n <= 100, "Limit muss zwischen 1 und 100 liegen")
//         .optional(),
//     })
//     .optional(),
// });

// Type Exports (NOCH NICHT IN VERWENDUNG!!! EVENTUELL GARNICHT NOTWENDIG!)
export type InsertTodo = z.infer<typeof InsertTodoSchema>;
export type SelectTodo = z.infer<typeof SelectTodoSchema>;

export type CreateTodoBody = z.infer<typeof createTodoSchema>;
export type UpdateTodoBody = z.infer<typeof updateTodoSchema>;
export type TodoByIdParams = z.infer<typeof todoByIdSchema>;
// export type QueryTodosQuery = z.infer<typeof queryTodosSchema>['query'];
