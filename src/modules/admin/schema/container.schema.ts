import { sql } from "drizzle-orm";
import { bigint, index, integer, pgEnum, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "@/modules/users/schema/user.schema";

// The api has no access to docker, the updater reports what it sees: a snapshot of all containers of the compose
// project (refreshed every few seconds) and the answers to log requests.

/** one row per container of the compose project, replaced completely on every refresh */
export const containerStatus = pgTable("container_status", {
  service: varchar("service", { length: 64 }).primaryKey(),
  containerName: varchar("container_name", { length: 128 }).notNull(),
  image: varchar("image", { length: 256 }).notNull(),
  // running, exited, restarting, ...
  state: varchar("state", { length: 32 }).notNull(),
  // healthy, unhealthy, starting or empty without a healthcheck
  health: varchar("health", { length: 32 }),
  // human readable, e.g. "Up 2 hours (healthy)"
  statusText: varchar("status_text", { length: 256 }).notNull(),
  exitCode: integer("exit_code"),
  // when the updater took the snapshot
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// queued -> done | failed
export const logRequestStatusEnum = pgEnum("log_request_status", ["queued", "done", "failed"]);

/** a short lived request for the last log lines of one service, answered by the updater */
export const containerLogRequests = pgTable(
  "container_log_requests",
  {
    logRequestId: uuid("log_request_id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    service: varchar("service", { length: 64 }).notNull(),
    tail: integer("tail").notNull(),
    status: logRequestStatusEnum("status").default("queued").notNull(),
    output: text("output"),
    error: text("error"),
    requestedBy: uuid("requested_by").references(() => users.userId, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    index("idx_container_log_requests_queued")
      .on(table.sequence)
      .where(sql`${table.status} = 'queued'`),
    index("idx_container_log_requests_created_at").on(table.createdAt),
  ],
);

export type ContainerStatusRecord = typeof containerStatus.$inferSelect;
export type NewContainerStatusRecord = Omit<typeof containerStatus.$inferInsert, "updatedAt">;
export type ContainerLogRequest = typeof containerLogRequests.$inferSelect;
