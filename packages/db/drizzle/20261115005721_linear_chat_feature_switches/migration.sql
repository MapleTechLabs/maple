-- metadata
CREATE TABLE IF NOT EXISTS "linear_feature_settings" (
	"org_id" text NOT NULL,
	"open_issues_enabled" boolean NOT NULL DEFAULT true,
	"update_comments_enabled" boolean NOT NULL DEFAULT true,
	"reopen_issues_enabled" boolean NOT NULL DEFAULT true,
	"resolve_comments_enabled" boolean NOT NULL DEFAULT true,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text,
	CONSTRAINT "linear_feature_settings_pkey" PRIMARY KEY ("org_id")
);
--> statement-breakpoint
-- metadata
ALTER TABLE "chat_workspaces" ADD COLUMN IF NOT EXISTS "alerts_enabled" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
-- metadata
ALTER TABLE "chat_workspaces" ADD COLUMN IF NOT EXISTS "direct_messages_enabled" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
-- metadata
ALTER TABLE "chat_workspaces" ADD COLUMN IF NOT EXISTS "assistant_enabled" boolean NOT NULL DEFAULT true;
