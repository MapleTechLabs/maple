CREATE TABLE `org_ingest_attribute_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`source_context` text NOT NULL,
	`source_key` text NOT NULL,
	`target_key` text NOT NULL,
	`operation` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `org_ingest_attribute_mappings_org_idx` ON `org_ingest_attribute_mappings` (`org_id`);
