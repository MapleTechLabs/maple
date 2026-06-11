CREATE TABLE `ai_triage_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`incident_kind` text NOT NULL,
	`incident_id` text NOT NULL,
	`issue_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`context_json` text DEFAULT '{}' NOT NULL,
	`result_json` text,
	`model` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_triage_runs_incident_idx` ON `ai_triage_runs` (`org_id`,`incident_kind`,`incident_id`);--> statement-breakpoint
CREATE INDEX `ai_triage_runs_org_issue_idx` ON `ai_triage_runs` (`org_id`,`issue_id`);--> statement-breakpoint
CREATE INDEX `ai_triage_runs_org_created_idx` ON `ai_triage_runs` (`org_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `ai_triage_settings` (
	`org_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`model_override` text,
	`max_runs_per_day` integer DEFAULT 20 NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `anomaly_detector_settings` (
	`org_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`sensitivity` text DEFAULT 'normal' NOT NULL,
	`muted_signals_json` text DEFAULT '[]' NOT NULL,
	`last_tick_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `anomaly_detector_states` (
	`org_id` text NOT NULL,
	`detector_key` text NOT NULL,
	`signal_type` text NOT NULL,
	`service_name` text NOT NULL,
	`deployment_env` text DEFAULT '' NOT NULL,
	`fingerprint_hash` text,
	`consecutive_breaches` integer DEFAULT 0 NOT NULL,
	`consecutive_healthy` integer DEFAULT 0 NOT NULL,
	`last_status` text,
	`last_value` real,
	`baseline_median` real,
	`last_sample_count` integer,
	`last_evaluated_at` integer,
	`open_incident_id` text,
	`last_resolved_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `detector_key`)
);
--> statement-breakpoint
CREATE INDEX `anomaly_detector_states_org_idx` ON `anomaly_detector_states` (`org_id`);--> statement-breakpoint
CREATE INDEX `anomaly_detector_states_open_incident_idx` ON `anomaly_detector_states` (`org_id`,`open_incident_id`);--> statement-breakpoint
CREATE INDEX `anomaly_detector_states_evaluated_idx` ON `anomaly_detector_states` (`last_evaluated_at`);--> statement-breakpoint
CREATE TABLE `anomaly_incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`detector_key` text NOT NULL,
	`signal_type` text NOT NULL,
	`service_name` text NOT NULL,
	`deployment_env` text DEFAULT '' NOT NULL,
	`fingerprint_hash` text,
	`error_issue_id` text,
	`status` text NOT NULL,
	`severity` text NOT NULL,
	`opened_value` real NOT NULL,
	`baseline_median` real NOT NULL,
	`baseline_sigma` real NOT NULL,
	`threshold_value` real NOT NULL,
	`last_observed_value` real NOT NULL,
	`last_sample_count` integer DEFAULT 0 NOT NULL,
	`first_triggered_at` integer NOT NULL,
	`last_triggered_at` integer NOT NULL,
	`resolved_at` integer,
	`resolve_reason` text,
	`triage_status` text DEFAULT 'none' NOT NULL,
	`dedupe_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `anomaly_incidents_org_status_idx` ON `anomaly_incidents` (`org_id`,`status`);--> statement-breakpoint
CREATE INDEX `anomaly_incidents_org_triggered_idx` ON `anomaly_incidents` (`org_id`,`last_triggered_at`);--> statement-breakpoint
CREATE INDEX `anomaly_incidents_org_detector_idx` ON `anomaly_incidents` (`org_id`,`detector_key`);--> statement-breakpoint
CREATE INDEX `anomaly_incidents_org_issue_idx` ON `anomaly_incidents` (`org_id`,`error_issue_id`);