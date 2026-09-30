CREATE TABLE "roles" (
	"role_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(64) NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"permission_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(100) NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "permissions_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("role_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("role_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_permission_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("permission_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_user_roles_user_id" ON "user_roles" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "idx_user_roles_role_id" ON "user_roles" USING btree ("role_id");
--> statement-breakpoint
CREATE INDEX "idx_role_permissions_role_id" ON "role_permissions" USING btree ("role_id");
--> statement-breakpoint
CREATE INDEX "idx_role_permissions_permission_id" ON "role_permissions" USING btree ("permission_id");
--> statement-breakpoint

INSERT INTO "permissions" ("key", "description")
VALUES
	('admin:all', 'Full administrative access'),
	('todos:read', 'Read todo entries'),
	('todos:create', 'Create todo entries'),
	('todos:update', 'Update todo entries'),
	('todos:delete', 'Delete todo entries'),
	('todo-comments:read', 'Read todo comments'),
	('todo-comments:create', 'Create todo comments'),
	('todo-comments:update', 'Update todo comments'),
	('todo-comments:delete', 'Delete todo comments'),
	('users:read', 'Read user profiles'),
	('users:update', 'Update user profiles'),
	('users:delete', 'Delete user profiles')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint

INSERT INTO "roles" ("name", "description")
VALUES
	('user', 'Default application user role'),
	('admin', 'Administrative role')
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r.role_id, p.permission_id
FROM "roles" r
JOIN "permissions" p ON p.key IN (
	'todos:read',
	'todos:create',
	'todos:update',
	'todos:delete',
	'todo-comments:read',
	'todo-comments:create',
	'todo-comments:update',
	'todo-comments:delete',
	'users:read',
	'users:update',
	'users:delete'
)
WHERE r.name = 'user'
ON CONFLICT ("role_id","permission_id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r.role_id, p.permission_id
FROM "roles" r
JOIN "permissions" p ON TRUE
WHERE r.name = 'admin'
ON CONFLICT ("role_id","permission_id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "user_roles" ("user_id", "role_id")
SELECT u.user_id, r.role_id
FROM "users" u
JOIN "roles" r ON r.name = 'user'
ON CONFLICT ("user_id","role_id") DO NOTHING;
