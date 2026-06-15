-- vcs_commits now references its owning vcs_repositories row by internal id
-- (`repository_id`) instead of the GitHub `external_repo_id`. SQLite cannot add a
-- NOT NULL column without a default, so recreate the table. Existing rows are
-- carried over by resolving the repo via (org_id, provider, external_repo_id);
-- any commit whose repo row is absent is dropped — a commit without a repo is no
-- longer meaningful (the INNER JOIN enforces that).
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_vcs_commits` (
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
	`branch` text,
	`created_at` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_vcs_commits` (`id`, `org_id`, `provider`, `repository_id`, `sha`, `message`, `author_name`, `author_email`, `author_login`, `author_avatar_url`, `authored_at`, `committed_at`, `html_url`, `branch`, `created_at`)
SELECT `c`.`id`, `c`.`org_id`, `c`.`provider`, `r`.`id`, `c`.`sha`, `c`.`message`, `c`.`author_name`, `c`.`author_email`, `c`.`author_login`, `c`.`author_avatar_url`, `c`.`authored_at`, `c`.`committed_at`, `c`.`html_url`, `c`.`branch`, `c`.`created_at`
FROM `vcs_commits` `c`
JOIN `vcs_repositories` `r`
	ON `r`.`org_id` = `c`.`org_id` AND `r`.`provider` = `c`.`provider` AND `r`.`external_repo_id` = `c`.`external_repo_id`;--> statement-breakpoint
DROP TABLE `vcs_commits`;--> statement-breakpoint
ALTER TABLE `__new_vcs_commits` RENAME TO `vcs_commits`;--> statement-breakpoint
CREATE UNIQUE INDEX `vcs_commits_repo_sha_idx` ON `vcs_commits` (`repository_id`,`sha`);--> statement-breakpoint
CREATE INDEX `vcs_commits_org_sha_idx` ON `vcs_commits` (`org_id`,`sha`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
