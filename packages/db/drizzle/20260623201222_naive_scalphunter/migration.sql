CREATE TABLE "vcs_commits" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"repository_id" text NOT NULL,
	"sha" text NOT NULL,
	"message" text NOT NULL,
	"author_name" text,
	"author_email" text,
	"author_login" text,
	"author_avatar_url" text,
	"authored_at" timestamp with time zone,
	"committed_at" timestamp with time zone NOT NULL,
	"html_url" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vcs_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_installation_id" text NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"external_account_id" text NOT NULL,
	"account_avatar_url" text,
	"repository_selection" text DEFAULT 'all' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"suspended_at" timestamp with time zone,
	"installed_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vcs_repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"installation_id" text NOT NULL,
	"external_repo_id" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"tracked_branch" text,
	"html_url" text NOT NULL,
	"is_private" boolean DEFAULT true NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"sync_status" text DEFAULT 'pending' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_sync_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vcs_repository_branches" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"repository_id" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"head_sha" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DROP TABLE "org_openrouter_settings" CASCADE;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD COLUMN "tags_json" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "vcs_commits_repo_sha_idx" ON "vcs_commits" USING btree ("repository_id","sha");--> statement-breakpoint
CREATE INDEX "vcs_commits_org_sha_idx" ON "vcs_commits" USING btree ("org_id","sha");--> statement-breakpoint
CREATE UNIQUE INDEX "vcs_installations_provider_external_idx" ON "vcs_installations" USING btree ("provider","external_installation_id");--> statement-breakpoint
CREATE INDEX "vcs_installations_org_idx" ON "vcs_installations" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vcs_repositories_org_repo_idx" ON "vcs_repositories" USING btree ("org_id","provider","external_repo_id");--> statement-breakpoint
CREATE INDEX "vcs_repositories_org_idx" ON "vcs_repositories" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "vcs_repositories_installation_idx" ON "vcs_repositories" USING btree ("installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vcs_repository_branches_repo_name_idx" ON "vcs_repository_branches" USING btree ("repository_id","name");--> statement-breakpoint
CREATE INDEX "vcs_repository_branches_org_idx" ON "vcs_repository_branches" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "ai_triage_settings" DROP COLUMN "model_override";