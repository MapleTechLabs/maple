CREATE TABLE "chat_workspaces" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"connector" text NOT NULL,
	"external_workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_workspaces_connector_external_idx" ON "chat_workspaces" ("connector","external_workspace_id");--> statement-breakpoint
CREATE INDEX "chat_workspaces_org_idx" ON "chat_workspaces" ("org_id");