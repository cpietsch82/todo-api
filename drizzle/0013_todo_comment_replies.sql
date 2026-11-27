ALTER TABLE "todo_comments" ADD COLUMN "parent_comment_id" uuid;--> statement-breakpoint
ALTER TABLE "todo_comments" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "todo_comments" ALTER COLUMN "comment" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "todo_comments" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "todo_comments" DROP CONSTRAINT "todo_comments_user_id_users_user_id_fk";--> statement-breakpoint
ALTER TABLE "todo_comments" ADD CONSTRAINT "todo_comments_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_comments" ADD CONSTRAINT "todo_comments_parent_comment_id_todo_comments_comment_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."todo_comments"("comment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_comments" ADD CONSTRAINT "todo_comments_text_unless_deleted" CHECK ("deleted_at" IS NOT NULL OR "comment" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "todo_comments" ADD CONSTRAINT "todo_comments_author_unless_deleted" CHECK ("deleted_at" IS NOT NULL OR "user_id" IS NOT NULL);--> statement-breakpoint
CREATE INDEX "idx_todo_comments_thread" ON "todo_comments" USING btree ("todo_id","parent_comment_id","created_at" DESC,"comment_id" DESC);--> statement-breakpoint
CREATE INDEX "idx_todo_comments_parent" ON "todo_comments" USING btree ("parent_comment_id");
