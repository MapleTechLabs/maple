-- metadata
CREATE TABLE IF NOT EXISTS "supabase_project_insights" (
	"project_id" text NOT NULL,
	"org_id" text NOT NULL,
	"advisors_json" jsonb NOT NULL DEFAULT '[]',
	"top_queries_json" jsonb NOT NULL DEFAULT '[]',
	"advisors_checked_at" timestamp with time zone,
	"queries_checked_at" timestamp with time zone,
	"advisors_error" text,
	"queries_error" text,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "supabase_project_insights_pkey" PRIMARY KEY ("project_id")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "supabase_project_insights_org_idx" ON "supabase_project_insights" USING btree ("org_id");
--> statement-breakpoint
-- metadata
ALTER TABLE "supabase_project_insights" ADD CONSTRAINT "supabase_project_insights_project_id_supabase_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "supabase_projects" ("id") ON DELETE CASCADE;
