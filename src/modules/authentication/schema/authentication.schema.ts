import { index, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { InsertUserSchema, users } from "@/modules/users/schema/user.schema";
import { createInsertSchema } from "drizzle-zod";
import z from "zod";
import { relations } from "drizzle-orm";

// table definition
export const authentications = pgTable(
  "authentications",
  {
    authId: uuid("auth_id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.userId, { onDelete: "cascade" }),
    password: varchar("password", { length: 255 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("idx_auth_user_id").on(table.userId)],
);

// refresh tokens are only stored as sha256 hash, so a database leak does not expose usable tokens
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    refreshTokenId: uuid("refresh_token_id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("idx_refresh_tokens_user_id").on(table.userId), index("idx_refresh_tokens_expires_at").on(table.expiresAt)],
);

export type Auth = typeof authentications.$inferSelect;
export type RefreshTokenRecord = typeof refreshTokens.$inferSelect;
export type NewRefreshTokenRecord = typeof refreshTokens.$inferInsert;
export type NewAuth = Omit<typeof authentications.$inferInsert, "authId" | "createdAt" | "updatedAt">;

export const authRelations = relations(authentications, ({ one }) => ({
  user: one(users, {
    fields: [authentications.userId],
    references: [users.userId],
  }),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, {
    fields: [refreshTokens.userId],
    references: [users.userId],
  }),
}));

export const InsertAuthSchema = createInsertSchema(authentications, {
  password: z.string().min(8, "Too short!"),
});

// this and the following is for the typed request in register route
const UserSchema = InsertUserSchema.omit({
  userId: true,
  createdAt: true,
  updatedAt: true,
});

export const registerSchema = UserSchema.extend({
  password: z.string().min(8),
});

// type UserBody = z.infer<typeof UserSchema>;

// type PasswordBody = {
//   password: string;
// };

// FIXME: try a better approach to set up the type for the registration body
export type RegisterBody = z.infer<typeof UserSchema> & {
  password: string;
};

// here we are fine again
export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
});

export type LoginBody = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string(),
});

export type RefreshBody = z.infer<typeof refreshSchema>;
