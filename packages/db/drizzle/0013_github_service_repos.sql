CREATE TABLE `github_service_repos` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`service_name` text NOT NULL,
	`repo_owner` text NOT NULL,
	`repo_name` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_service_repos_org_service_idx` ON `github_service_repos` (`org_id`,`service_name`);--> statement-breakpoint
CREATE INDEX `github_service_repos_org_idx` ON `github_service_repos` (`org_id`);--> statement-breakpoint
ALTER TABLE `oauth_connections` ADD `external_user_label` text;
