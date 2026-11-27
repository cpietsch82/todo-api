CREATE TABLE "todo_comment_mentions" (
	"comment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "todo_comment_mentions_comment_id_user_id_pk" PRIMARY KEY("comment_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "todo_comment_mentions" ADD CONSTRAINT "todo_comment_mentions_comment_id_todo_comments_comment_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."todo_comments"("comment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_comment_mentions" ADD CONSTRAINT "todo_comment_mentions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_todo_comment_mentions_user_id" ON "todo_comment_mentions" USING btree ("user_id");
