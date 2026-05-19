CREATE TABLE `github_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`installation_id` integer NOT NULL,
	`app_slug` text NOT NULL,
	`account_id` integer NOT NULL,
	`account_login` text NOT NULL,
	`account_avatar_url` text,
	`account_type` text NOT NULL,
	`target_type` text NOT NULL,
	`repository_selection` text NOT NULL,
	`permissions_json` text DEFAULT '{}' NOT NULL,
	`events_json` text DEFAULT '[]' NOT NULL,
	`suspended_at` integer,
	`installed_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_installations_org_installation_idx` ON `github_installations` (`org_id`,`installation_id`);--> statement-breakpoint
CREATE INDEX `github_installations_org_idx` ON `github_installations` (`org_id`);--> statement-breakpoint
CREATE INDEX `github_installations_installation_idx` ON `github_installations` (`installation_id`);--> statement-breakpoint
CREATE TABLE `github_repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`github_repo_id` integer NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`default_branch` text NOT NULL,
	`private` integer DEFAULT 0 NOT NULL,
	`html_url` text NOT NULL,
	`sync_enabled` integer DEFAULT 1 NOT NULL,
	`last_synced_at` integer,
	`last_full_backfill_at` integer,
	`backfill_status` text DEFAULT 'pending' NOT NULL,
	`backfill_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_repositories_org_repo_idx` ON `github_repositories` (`org_id`,`github_repo_id`);--> statement-breakpoint
CREATE INDEX `github_repositories_org_installation_idx` ON `github_repositories` (`org_id`,`installation_id`);--> statement-breakpoint
CREATE TABLE `github_commits` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`sha` text NOT NULL,
	`short_sha` text NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`author_login` text,
	`author_name` text,
	`author_email` text,
	`author_avatar_url` text,
	`committer_login` text,
	`committer_name` text,
	`committer_email` text,
	`committer_avatar_url` text,
	`authored_at` integer NOT NULL,
	`committed_at` integer NOT NULL,
	`html_url` text NOT NULL,
	`branches_json` text DEFAULT '[]' NOT NULL,
	`pr_number` integer,
	`synced_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_commits_org_sha_idx` ON `github_commits` (`org_id`,`sha`);--> statement-breakpoint
CREATE INDEX `github_commits_org_repo_idx` ON `github_commits` (`org_id`,`repo_id`);--> statement-breakpoint
CREATE INDEX `github_commits_org_committed_idx` ON `github_commits` (`org_id`,`committed_at`);--> statement-breakpoint
CREATE TABLE `github_releases` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`github_release_id` integer NOT NULL,
	`tag_name` text NOT NULL,
	`name` text,
	`body` text,
	`draft` integer DEFAULT 0 NOT NULL,
	`prerelease` integer DEFAULT 0 NOT NULL,
	`target_commit_sha` text,
	`html_url` text NOT NULL,
	`author_login` text,
	`author_avatar_url` text,
	`published_at` integer,
	`created_at` integer NOT NULL,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_releases_org_release_idx` ON `github_releases` (`org_id`,`github_release_id`);--> statement-breakpoint
CREATE INDEX `github_releases_org_target_sha_idx` ON `github_releases` (`org_id`,`target_commit_sha`);--> statement-breakpoint
CREATE INDEX `github_releases_org_repo_published_idx` ON `github_releases` (`org_id`,`repo_id`,`published_at`);--> statement-breakpoint
CREATE TABLE `github_unresolved_shas` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`sha` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` integer NOT NULL,
	`permanent` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_unresolved_shas_org_sha_idx` ON `github_unresolved_shas` (`org_id`,`sha`);--> statement-breakpoint
CREATE INDEX `github_unresolved_shas_attempt_idx` ON `github_unresolved_shas` (`last_attempt_at`);
