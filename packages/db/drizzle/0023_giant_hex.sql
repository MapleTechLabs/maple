ALTER TABLE `error_issues` ADD `kind` text DEFAULT 'error' NOT NULL;--> statement-breakpoint
ALTER TABLE `error_issues` ADD `source_ref_json` text;--> statement-breakpoint
ALTER TABLE `error_issues` ADD `severity` text;--> statement-breakpoint
ALTER TABLE `error_issues` ADD `severity_source` text;--> statement-breakpoint
CREATE INDEX `error_issues_org_severity_idx` ON `error_issues` (`org_id`,`severity`);