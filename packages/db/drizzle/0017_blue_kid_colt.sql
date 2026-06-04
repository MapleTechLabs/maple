CREATE TABLE `org_recommendation_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`number` integer NOT NULL,
	`recommendation_key` text NOT NULL,
	`kind` text NOT NULL,
	`source_key` text NOT NULL,
	`canonical_key` text,
	`status` text DEFAULT 'open' NOT NULL,
	`usage_count` integer DEFAULT 0 NOT NULL,
	`opened_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `org_recommendation_issues_org_idx` ON `org_recommendation_issues` (`org_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `org_recommendation_issues_org_key_idx` ON `org_recommendation_issues` (`org_id`,`recommendation_key`);