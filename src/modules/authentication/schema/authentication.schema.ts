import { index, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { emailSchema, InsertUserSchema, users } from "@/modules/users/schema/user.schema";
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

// refresh tokens are only stored as sha256 hash, so a database leak does not expose usable tokens.
// All tokens created by rotating one login share a family id. A token is marked as used when it was rotated,
// presenting a used token again is a sign of theft and revokes the whole family.
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    refreshTokenId: uuid("refresh_token_id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    familyId: uuid("family_id").defaultRandom().notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_refresh_tokens_user_id").on(table.userId),
    index("idx_refresh_tokens_expires_at").on(table.expiresAt),
    index("idx_refresh_tokens_family_id").on(table.familyId),
  ],
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

// bcrypt only uses the first 72 bytes of a password, everything after it would be ignored silently
export const PASSWORD_MAX_BYTES = 72;

/** A new password. The login does not check the maximum, so older, longer passwords keep working. */
export const newPasswordSchema = z
  .string()
  .min(8)
  .refine((password) => Buffer.byteLength(password, "utf8") <= PASSWORD_MAX_BYTES, {
    message: `Password must not be longer than ${PASSWORD_MAX_BYTES} bytes`,
  });

export const registerSchema = UserSchema.extend({
  password: newPasswordSchema,
});

// type UserBody = z.infer<typeof UserSchema>;

// type PasswordBody = {
//   password: string;
// };

// FIXME: try a better approach to set up the type for the registration body
export type RegisterBody = z.infer<typeof registerSchema>;

// here we are fine again
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(8),
});

export type LoginBody = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  // the api creates tokens of 128 hex characters, the maximum leaves room for a longer format later
  refreshToken: z.string().max(256),
});

export type RefreshBody = z.infer<typeof refreshSchema>;
