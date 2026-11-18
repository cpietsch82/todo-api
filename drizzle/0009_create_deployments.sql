CREATE TYPE "public"."deployment_action" AS ENUM('pull', 'deploy', 'restart');
--> statement-breakpoint
CREATE TYPE "public"."deployment_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'rolled_back');
--> statement-breakpoint
CREATE TABLE "deployments" (
	"deployment_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
	"action" "deployment_action" NOT NULL,
	"status" "deployment_status" DEFAULT 'queued' NOT NULL,
	"target_tag" varchar(64),
	"previous_tag" varchar(64),
	"requested_by" uuid,
	"output" text,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	CONSTRAINT "chk_deployments_target_tag" CHECK (("action" = 'restart' and "target_tag" is null) or ("action" <> 'restart' and "target_tag" is not null))
);
--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_requested_by_users_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_deployments_sequence" ON "deployments" USING btree ("sequence");
--> statement-breakpoint
CREATE INDEX "idx_deployments_status" ON "deployments" USING btree ("status");
--> statement-breakpoint
-- only one operation may be queued or running at a time
CREATE UNIQUE INDEX "uq_deployments_one_active" ON "deployments" USING btree ((true)) WHERE "status" in ('queued', 'running');
