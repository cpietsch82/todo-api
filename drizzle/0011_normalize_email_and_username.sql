-- E-mails are stored in lowercase and without surrounding whitespace, so "Max@x.de" and "max@x.de" are one account.
-- If two users only differ in the spelling of their e-mail, the update fails on the unique constraint on purpose:
-- accounts are never merged silently. Check before the deploy:
--   SELECT lower(trim(email)), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;
UPDATE "users" SET "email" = lower(trim("email")) WHERE "email" <> lower(trim("email"));
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "chk_users_email_lowercase" CHECK ("email" = lower("email"));
--> statement-breakpoint
-- The username keeps its spelling, but "Max" and "max" may not exist both. Fails as well if such a pair exists:
--   SELECT lower(username), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;
CREATE UNIQUE INDEX "uq_users_username_lower" ON "users" USING btree (lower("username"));
