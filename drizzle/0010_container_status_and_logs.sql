CREATE TABLE "container_status" (
	"service" varchar(64) PRIMARY KEY NOT NULL,
	"container_name" varchar(128) NOT NULL,
	"image" varchar(256) NOT NULL,
	"state" varchar(32) NOT NULL,
	"health" varchar(32),
	"status_text" varchar(256) NOT NULL,
	"exit_code" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TYPE "public"."log_request_status" AS ENUM('queued', 'done', 'failed');
--> statement-breakpoint
CREATE TABLE "container_log_requests" (
	"log_request_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
	"service" varchar(64) NOT NULL,
	"tail" integer NOT NULL,
	"status" "log_request_status" DEFAULT 'queued' NOT NULL,
	"output" text,
	"error" text,
	"requested_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "container_log_requests" ADD CONSTRAINT "container_log_requests_requested_by_users_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_container_log_requests_queued" ON "container_log_requests" USING btree ("sequence") WHERE "status" = 'queued';
--> statement-breakpoint
CREATE INDEX "idx_container_log_requests_created_at" ON "container_log_requests" USING btree ("created_at");
