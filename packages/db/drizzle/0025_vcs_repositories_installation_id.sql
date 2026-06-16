-- vcs_repositories now references its owning vcs_installations row by internal id
-- (`installation_id`) instead of the provider's `external_installation_id`. This
-- mirrors the vcs_commits → vcs_repositories link (migration 0024): the whole VCS
-- tree links by Maple's internal ids, and external ids live only on the row that
-- owns them. SQLite cannot add a NOT NULL column without a default, so recreate the
-- table. Existing rows carry over by resolving the installation via
-- (provider, external_installation_id); any repo whose installation row is absent
-- is dropped — an orphan repo is not meaningful (the INNER JOIN enforces that).
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_vcs_repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`provider` text NOT NULL,
	`installation_id` text NOT NULL,
	`external_repo_id` text NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`full_name` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`html_url` text NOT NULL,
	`is_private` integer DEFAULT 1 NOT NULL,
	`is_archived` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`sync_status` text DEFAULT 'pending' NOT NULL,
	`last_synced_at` integer,
	`last_sync_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_vcs_repositories` (`id`, `org_id`, `provider`, `installation_id`, `external_repo_id`, `owner`, `name`, `full_name`, `default_branch`, `html_url`, `is_private`, `is_archived`, `status`, `sync_status`, `last_synced_at`, `last_sync_error`, `created_at`, `updated_at`)
SELECT `r`.`id`, `r`.`org_id`, `r`.`provider`, `i`.`id`, `r`.`external_repo_id`, `r`.`owner`, `r`.`name`, `r`.`full_name`, `r`.`default_branch`, `r`.`html_url`, `r`.`is_private`, `r`.`is_archived`, `r`.`status`, `r`.`sync_status`, `r`.`last_synced_at`, `r`.`last_sync_error`, `r`.`created_at`, `r`.`updated_at`
FROM `vcs_repositories` `r`
JOIN `vcs_installations` `i`
	ON `i`.`provider` = `r`.`provider` AND `i`.`external_installation_id` = `r`.`external_installation_id`;--> statement-breakpoint
DROP TABLE `vcs_repositories`;--> statement-breakpoint
ALTER TABLE `__new_vcs_repositories` RENAME TO `vcs_repositories`;--> statement-breakpoint
CREATE UNIQUE INDEX `vcs_repositories_org_repo_idx` ON `vcs_repositories` (`org_id`,`provider`,`external_repo_id`);--> statement-breakpoint
CREATE INDEX `vcs_repositories_org_idx` ON `vcs_repositories` (`org_id`);--> statement-breakpoint
CREATE INDEX `vcs_repositories_installation_idx` ON `vcs_repositories` (`installation_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
