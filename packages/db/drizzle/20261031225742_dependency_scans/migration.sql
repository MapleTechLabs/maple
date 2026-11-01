-- metadata
CREATE TABLE IF NOT EXISTS "dependency_findings" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"lockfile_path" text NOT NULL,
	"ecosystem" text NOT NULL,
	"package_name" text NOT NULL,
	"advisory_id" text NOT NULL,
	"aliases" jsonb NOT NULL,
	"severity" text NOT NULL,
	"summary" text,
	"versions" jsonb NOT NULL,
	"fixed_in" text,
	"relation" text NOT NULL,
	"status" text NOT NULL DEFAULT 'open',
	"first_seen_scan_id" text NOT NULL,
	"last_seen_scan_id" text NOT NULL,
	"first_seen_sha" text NOT NULL,
	"last_seen_sha" text NOT NULL,
	"fixed_scan_id" text,
	"fixed_sha" text,
	"status_reason" text,
	"status_changed_by" text,
	"status_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "dependency_findings_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "dependency_scan_matches" (
	"scan_id" text NOT NULL,
	"org_id" text NOT NULL,
	"lockfile_path" text NOT NULL,
	"ecosystem" text NOT NULL,
	"package_name" text NOT NULL,
	"version" text NOT NULL,
	"relation" text NOT NULL,
	"advisory_id" text NOT NULL,
	"aliases" jsonb NOT NULL,
	"severity" text NOT NULL,
	"summary" text,
	"fixed_in" text,
	CONSTRAINT "dependency_scan_matches_pkey" PRIMARY KEY ("scan_id", "lockfile_path", "ecosystem", "package_name", "version", "advisory_id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "dependency_scans" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"ref" text,
	"trigger" text NOT NULL,
	"default_branch_head" boolean NOT NULL,
	"status" text NOT NULL DEFAULT 'running',
	"lockfiles" jsonb NOT NULL,
	"package_count" integer NOT NULL DEFAULT 0,
	"vulnerable_count" integer NOT NULL DEFAULT 0,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "dependency_scans_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "dependency_findings_key_idx" ON "dependency_findings" USING btree ("repository_id", "lockfile_path", "ecosystem", "package_name", "advisory_id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "dependency_findings_org_status_idx" ON "dependency_findings" USING btree ("org_id", "status");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "dependency_findings_org_updated_idx" ON "dependency_findings" USING btree ("org_id", "updated_at");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "dependency_scan_matches_org_scan_idx" ON "dependency_scan_matches" USING btree ("org_id", "scan_id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "dependency_scans_org_started_idx" ON "dependency_scans" USING btree ("org_id", "started_at");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "dependency_scans_repo_commit_idx" ON "dependency_scans" USING btree ("repository_id", "commit_sha");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "dependency_scans_repo_started_idx" ON "dependency_scans" USING btree ("repository_id", "started_at");
