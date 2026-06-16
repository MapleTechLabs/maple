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
CREATE INDEX `vcs_repository_branches_org_idx` ON `vcs_repository_branches` (`org_id`);--> statement-breakpoint
ALTER TABLE `vcs_repositories` ADD `tracked_branch` text;--> statement-breakpoint
ALTER TABLE `vcs_commits` DROP COLUMN `branch`;