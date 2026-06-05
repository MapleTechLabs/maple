CREATE TABLE `alert_incident_events` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`incident_id` text NOT NULL,
	`type` text NOT NULL,
	`actor_id` text,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alert_incident_events_incident_idx` ON `alert_incident_events` (`org_id`,`incident_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `alert_incident_events_type_idx` ON `alert_incident_events` (`org_id`,`type`,`created_at`);--> statement-breakpoint
CREATE TABLE `alert_incident_issue_links` (
	`org_id` text NOT NULL,
	`alert_incident_id` text NOT NULL,
	`error_issue_id` text NOT NULL,
	`relationship` text NOT NULL,
	`score` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `alert_incident_id`, `error_issue_id`)
);
--> statement-breakpoint
CREATE INDEX `alert_incident_issue_links_issue_idx` ON `alert_incident_issue_links` (`org_id`,`error_issue_id`);--> statement-breakpoint
CREATE INDEX `alert_incident_issue_links_incident_idx` ON `alert_incident_issue_links` (`org_id`,`alert_incident_id`);--> statement-breakpoint
ALTER TABLE `alert_incidents` ADD `threshold_mode` text DEFAULT 'static' NOT NULL;--> statement-breakpoint
ALTER TABLE `alert_incidents` ADD `baseline_median` real;--> statement-breakpoint
ALTER TABLE `alert_incidents` ADD `baseline_lower` real;--> statement-breakpoint
ALTER TABLE `alert_incidents` ADD `baseline_upper` real;--> statement-breakpoint
ALTER TABLE `alert_incidents` ADD `baseline_bucket_count` integer;--> statement-breakpoint
ALTER TABLE `alert_incidents` ADD `anomaly_score` real;--> statement-breakpoint
ALTER TABLE `alert_incidents` ADD `effective_threshold` real;--> statement-breakpoint
ALTER TABLE `alert_incidents` ADD `investigation_id` text;--> statement-breakpoint
ALTER TABLE `alert_rules` ADD `threshold_mode` text DEFAULT 'static' NOT NULL;--> statement-breakpoint
ALTER TABLE `alert_rules` ADD `anomaly_config_json` text;--> statement-breakpoint
ALTER TABLE `alert_rules` ADD `evaluation_interval_minutes` integer DEFAULT 1 NOT NULL;