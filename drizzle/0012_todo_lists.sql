CREATE TYPE "public"."todo_list_role" AS ENUM('editor', 'viewer');--> statement-breakpoint
CREATE TABLE "todo_lists" (
	"list_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "todo_lists" ADD CONSTRAINT "todo_lists_owner_id_users_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_todo_lists_owner_id" ON "todo_lists" USING btree ("owner_id");--> statement-breakpoint
CREATE TABLE "todo_list_members" (
	"list_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "todo_list_role" NOT NULL,
	"added_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "todo_list_members_list_id_user_id_pk" PRIMARY KEY("list_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "todo_list_members" ADD CONSTRAINT "todo_list_members_list_id_todo_lists_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."todo_lists"("list_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_list_members" ADD CONSTRAINT "todo_list_members_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_list_members" ADD CONSTRAINT "todo_list_members_added_by_users_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_todo_list_members_user_id" ON "todo_list_members" USING btree ("user_id");--> statement-breakpoint
CREATE TABLE "todo_list_invitations" (
	"invitation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"invitee_id" uuid,
	"token_hash" varchar(64),
	"role" "todo_list_role" DEFAULT 'viewer' NOT NULL,
	"invited_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "todo_list_invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "chk_todo_list_invitations_target" CHECK (("invitee_id" IS NULL) <> ("token_hash" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "todo_list_invitations" ADD CONSTRAINT "todo_list_invitations_list_id_todo_lists_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."todo_lists"("list_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_list_invitations" ADD CONSTRAINT "todo_list_invitations_invitee_id_users_user_id_fk" FOREIGN KEY ("invitee_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_list_invitations" ADD CONSTRAINT "todo_list_invitations_invited_by_users_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_todo_list_invitations_list_invitee" ON "todo_list_invitations" USING btree ("list_id","invitee_id") WHERE "invitee_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "list_id" uuid;--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_list_id_todo_lists_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."todo_lists"("list_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_todos_list_id" ON "todos" USING btree ("list_id");--> statement-breakpoint
ALTER TABLE "todos" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "todos" DROP CONSTRAINT "todos_user_id_users_user_id_fk";--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "chk_todos_owner_or_list" CHECK ("user_id" IS NOT NULL OR "list_id" IS NOT NULL);--> statement-breakpoint
INSERT INTO "permissions" ("key", "description")
VALUES
	('todo-lists:read', 'Read todo lists'),
	('todo-lists:create', 'Create todo lists'),
	('todo-lists:update', 'Update todo lists'),
	('todo-lists:delete', 'Delete todo lists'),
	('todo-lists:share', 'Share todo lists')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r.role_id, p.permission_id
FROM "roles" r
JOIN "permissions" p ON p.key IN ('todo-lists:read', 'todo-lists:create', 'todo-lists:update', 'todo-lists:delete', 'todo-lists:share')
WHERE r.name IN ('user', 'admin')
ON CONFLICT ("role_id","permission_id") DO NOTHING;
