CREATE TABLE `vcs_commits` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`provider` text NOT NULL,
	`repository_id` text NOT NULL,
	`sha` text NOT NULL,
	`message` text NOT NULL,
	`author_name` text,
	`author_email` text,
	`author_login` text,
	`author_avatar_url` text,
	`authored_at` integer,
	`committed_at` integer NOT NULL,
	`html_url` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vcs_commits_repo_sha_idx` ON `vcs_commits` (`repository_id`,`sha`);--> statement-breakpoint
CREATE INDEX `vcs_commits_org_sha_idx` ON `vcs_commits` (`org_id`,`sha`);--> statement-breakpoint
CREATE TABLE `vcs_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_installation_id` text NOT NULL,
	`account_login` text NOT NULL,
	`account_type` text NOT NULL,
	`external_account_id` text NOT NULL,
	`account_avatar_url` text,
	`repository_selection` text DEFAULT 'all' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`suspended_at` integer,
	`installed_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vcs_installations_provider_external_idx` ON `vcs_installations` (`provider`,`external_installation_id`);--> statement-breakpoint
CREATE INDEX `vcs_installations_org_idx` ON `vcs_installations` (`org_id`);--> statement-breakpoint
CREATE TABLE `vcs_repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`provider` text NOT NULL,
	`installation_id` text NOT NULL,
	`external_repo_id` text NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`full_name` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`tracked_branch` text,
	`html_url` text NOT NULL,
	`is_private` integer DEFAULT 1 NOT NULL,
	`is_archived` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`sync_status` text DEFAULT 'pending' NOT NULL,
	`last_synced_at` integer,
	`last_sync_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vcs_repositories_org_repo_idx` ON `vcs_repositories` (`org_id`,`provider`,`external_repo_id`);--> statement-breakpoint
CREATE INDEX `vcs_repositories_org_idx` ON `vcs_repositories` (`org_id`);--> statement-breakpoint
CREATE INDEX `vcs_repositories_installation_idx` ON `vcs_repositories` (`installation_id`);--> statement-breakpoint
CREATE TABLE `vcs_repository_branches` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`provider` text NOT NULL,
	`repository_id` text NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`head_sha` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vcs_repository_branches_repo_name_idx` ON `vcs_repository_branches` (`repository_id`,`name`);--> statement-breakpoint
CREATE INDEX `vcs_repository_branches_org_idx` ON `vcs_repository_branches` (`org_id`);