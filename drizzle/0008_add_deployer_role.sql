INSERT INTO "permissions" ("key", "description")
VALUES
	('admin:docker:status', 'Show the status of all containers of the compose file'),
	('admin:docker:logs', 'Show the logs of the containers'),
	('admin:docker:pull', 'Pull images of the api container'),
	('admin:docker:deploy', 'Switch the api container to another version (update and rollback)'),
	('admin:docker:restart', 'Restart the api container')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint

INSERT INTO "roles" ("name", "description")
VALUES ('deployer', 'Controls the docker containers of the api, granted to single admins only')
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint

-- only the role deployer gets the docker permissions, the role admin deliberately does not
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r.role_id, p.permission_id
FROM "roles" r
JOIN "permissions" p ON p.key LIKE 'admin:docker:%'
WHERE r.name = 'deployer'
ON CONFLICT ("role_id","permission_id") DO NOTHING;
