CREATE TABLE `issue_escalation_policies` (
	`org_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`rules_json` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `issue_escalations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`severity` text NOT NULL,
	`source` text NOT NULL,
	`reason` text NOT NULL,
	`run_id` text,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`dedupe_key` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`processed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_escalations_dedupe_idx` ON `issue_escalations` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `issue_escalations_due_idx` ON `issue_escalations` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `issue_escalations_org_issue_idx` ON `issue_escalations` (`org_id`,`issue_id`);--> statement-breakpoint
ALTER TABLE `alert_incidents` ADD `error_issue_id` text;--> statement-breakpoint
CREATE INDEX `alert_incidents_org_issue_idx` ON `alert_incidents` (`org_id`,`error_issue_id`);