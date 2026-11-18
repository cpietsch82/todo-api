import { relations, sql } from "drizzle-orm";
import { bigint, check, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "@/modules/users/schema/user.schema";

// Operations that change the docker containers. They are executed one after another by the updater, the api only
// creates them. Reading the status or the logs of the containers is no such operation and is not stored here.
export const deploymentActionEnum = pgEnum("deployment_action", ["pull", "deploy", "restart"]);

// queued -> running -> succeeded | failed | rolled_back (a deploy whose new version did not become healthy)
export const deploymentStatusEnum = pgEnum("deployment_status", ["queued", "running", "succeeded", "failed", "rolled_back"]);

export const deployments = pgTable(
  "deployments",
  {
    deploymentId: uuid("deployment_id").defaultRandom().primaryKey(),
    // strictly increasing, gives a defined order even when two rows have the same created_at
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    action: deploymentActionEnum("action").notNull(),
    status: deploymentStatusEnum("status").default("queued").notNull(),
    // image tag of the api for pull and deploy, empty for restart
    targetTag: varchar("target_tag", { length: 64 }),
    // tag that ran before a deploy, set by the updater, used for the rollback
    previousTag: varchar("previous_tag", { length: 64 }),
    // kept when the user is deleted, so the history stays complete
    requestedBy: uuid("requested_by").references(() => users.userId, { onDelete: "set null" }),
    // end of the command output (trimmed) and a short error message of a failed operation
    output: text("output"),
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    index("idx_deployments_sequence").on(table.sequence),
    index("idx_deployments_status").on(table.status),
    // only one operation may be queued or running at a time, enforced by the database even for parallel requests
    uniqueIndex("uq_deployments_one_active")
      .on(sql`(true)`)
      .where(sql`${table.status} in ('queued', 'running')`),
    check(
      "chk_deployments_target_tag",
      sql`(${table.action} = 'restart' and ${table.targetTag} is null) or (${table.action} <> 'restart' and ${table.targetTag} is not null)`,
    ),
  ],
);

export const deploymentsRelations = relations(deployments, ({ one }) => ({
  requester: one(users, {
    fields: [deployments.requestedBy],
    references: [users.userId],
  }),
}));

export type Deployment = typeof deployments.$inferSelect;
export type DeploymentAction = (typeof deploymentActionEnum.enumValues)[number];
export type DeploymentStatus = (typeof deploymentStatusEnum.enumValues)[number];
