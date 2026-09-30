CREATE TYPE "public"."todo_severity" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "severity" "todo_severity" DEFAULT 'medium' NOT NULL;
