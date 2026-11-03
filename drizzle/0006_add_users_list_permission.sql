INSERT INTO "permissions" ("key", "description")
VALUES ('users:list', 'List all user profiles')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r.role_id, p.permission_id
FROM "roles" r
JOIN "permissions" p ON p.key = 'users:list'
WHERE r.name = 'admin'
ON CONFLICT ("role_id","permission_id") DO NOTHING;
