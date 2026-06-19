ALTER TABLE `anomaly_detector_states` ADD `last_incident_id` text;--> statement-breakpoint
ALTER TABLE `anomaly_incidents` ADD `fingerprints_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `anomaly_incidents` ADD `reopen_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `anomaly_incidents` ADD `last_reopened_at` integer;