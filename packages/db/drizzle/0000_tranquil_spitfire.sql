CREATE TABLE "ai_triage_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"incident_kind" text NOT NULL,
	"incident_id" text NOT NULL,
	"issue_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"context_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result_json" jsonb,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_triage_settings" (
	"org_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"max_runs_per_day" integer DEFAULT 20 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "alert_delivery_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"incident_id" text,
	"rule_id" text NOT NULL,
	"destination_id" text NOT NULL,
	"delivery_key" text NOT NULL,
	"event_type" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_expires_at" timestamp with time zone,
	"claimed_by" text,
	"attempted_at" timestamp with time zone,
	"provider_message" text,
	"provider_reference" text,
	"response_code" integer,
	"error_message" text,
	"payload_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_destinations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config_json" jsonb NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_tag" text NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_test_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"incident_key" text NOT NULL,
	"rule_name" text NOT NULL,
	"group_key" text,
	"signal_type" text NOT NULL,
	"severity" text NOT NULL,
	"status" text NOT NULL,
	"comparator" text NOT NULL,
	"threshold" double precision NOT NULL,
	"threshold_upper" double precision,
	"first_triggered_at" timestamp with time zone NOT NULL,
	"last_triggered_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"last_observed_value" double precision,
	"last_sample_count" integer,
	"last_evaluated_at" timestamp with time zone,
	"dedupe_key" text NOT NULL,
	"last_delivered_event_type" text,
	"last_notified_at" timestamp with time zone,
	"error_issue_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_rule_states" (
	"org_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"group_key" text DEFAULT '__total__' NOT NULL,
	"consecutive_breaches" integer DEFAULT 0 NOT NULL,
	"consecutive_healthy" integer DEFAULT 0 NOT NULL,
	"last_status" text,
	"last_value" double precision,
	"last_sample_count" integer,
	"last_evaluated_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "alert_rule_states_org_id_rule_id_group_key_pk" PRIMARY KEY("org_id","rule_id","group_key")
);
--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"notification_template_json" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"severity" text NOT NULL,
	"service_names_json" jsonb,
	"exclude_service_names_json" jsonb,
	"tags_json" jsonb,
	"signal_type" text NOT NULL,
	"comparator" text NOT NULL,
	"threshold" double precision NOT NULL,
	"threshold_upper" double precision,
	"window_minutes" integer NOT NULL,
	"minimum_sample_count" integer DEFAULT 0 NOT NULL,
	"consecutive_breaches_required" integer DEFAULT 2 NOT NULL,
	"consecutive_healthy_required" integer DEFAULT 2 NOT NULL,
	"renotify_interval_minutes" integer DEFAULT 30 NOT NULL,
	"metric_name" text,
	"metric_type" text,
	"metric_aggregation" text,
	"apdex_threshold_ms" double precision,
	"query_builder_draft_json" jsonb,
	"raw_query_sql" text,
	"group_by" text,
	"destination_ids_json" jsonb NOT NULL,
	"query_spec_json" jsonb,
	"reducer" text NOT NULL,
	"sample_count_strategy" text,
	"no_data_behavior" text NOT NULL,
	"last_scheduled_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anomaly_detector_settings" (
	"org_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sensitivity" text DEFAULT 'normal' NOT NULL,
	"muted_signals_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_tick_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "anomaly_detector_states" (
	"org_id" text NOT NULL,
	"detector_key" text NOT NULL,
	"signal_type" text NOT NULL,
	"service_name" text NOT NULL,
	"deployment_env" text DEFAULT '' NOT NULL,
	"fingerprint_hash" text,
	"consecutive_breaches" integer DEFAULT 0 NOT NULL,
	"consecutive_healthy" integer DEFAULT 0 NOT NULL,
	"last_status" text,
	"last_value" double precision,
	"baseline_median" double precision,
	"last_sample_count" integer,
	"last_evaluated_at" timestamp with time zone,
	"open_incident_id" text,
	"last_resolved_at" timestamp with time zone,
	"last_incident_id" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "anomaly_detector_states_org_id_detector_key_pk" PRIMARY KEY("org_id","detector_key")
);
--> statement-breakpoint
CREATE TABLE "anomaly_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"detector_key" text NOT NULL,
	"signal_type" text NOT NULL,
	"service_name" text NOT NULL,
	"deployment_env" text DEFAULT '' NOT NULL,
	"fingerprint_hash" text,
	"error_issue_id" text,
	"status" text NOT NULL,
	"severity" text NOT NULL,
	"opened_value" double precision NOT NULL,
	"baseline_median" double precision NOT NULL,
	"baseline_sigma" double precision NOT NULL,
	"threshold_value" double precision NOT NULL,
	"last_observed_value" double precision NOT NULL,
	"last_sample_count" integer DEFAULT 0 NOT NULL,
	"first_triggered_at" timestamp with time zone NOT NULL,
	"last_triggered_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolve_reason" text,
	"triage_status" text DEFAULT 'none' NOT NULL,
	"dedupe_key" text NOT NULL,
	"fingerprints_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"last_reopened_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"metadata_json" jsonb,
	"kind" text DEFAULT 'standard' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"created_by_email" text
);
--> statement-breakpoint
CREATE TABLE "cloudflare_logpush_connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"zone_name" text NOT NULL,
	"service_name" text NOT NULL,
	"dataset" text DEFAULT 'http_requests' NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_tag" text NOT NULL,
	"secret_hash" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_received_at" timestamp with time zone,
	"last_error" text,
	"secret_rotated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_versions" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"dashboard_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"snapshot_json" jsonb NOT NULL,
	"change_kind" text NOT NULL,
	"change_summary" text,
	"source_version_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "dashboard_versions_org_id_id_pk" PRIMARY KEY("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "dashboards" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "dashboards_org_id_id_pk" PRIMARY KEY("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "digest_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"day_of_week" integer DEFAULT 1 NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"last_sent_at" timestamp with time zone,
	"last_attempted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "actors" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"type" text NOT NULL,
	"user_id" text,
	"agent_name" text,
	"model" text,
	"capabilities_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"last_active_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "error_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"first_triggered_at" timestamp with time zone NOT NULL,
	"last_triggered_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"occurrence_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "error_issue_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"actor_id" text,
	"type" text NOT NULL,
	"from_state" text,
	"to_state" text,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "error_issue_states" (
	"org_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"last_observed_occurrence_at" timestamp with time zone,
	"last_evaluated_at" timestamp with time zone,
	"open_incident_id" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "error_issue_states_org_id_issue_id_pk" PRIMARY KEY("org_id","issue_id")
);
--> statement-breakpoint
CREATE TABLE "error_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" text DEFAULT 'error' NOT NULL,
	"source_ref_json" jsonb,
	"fingerprint_hash" text NOT NULL,
	"service_name" text NOT NULL,
	"exception_type" text NOT NULL,
	"exception_message" text NOT NULL,
	"error_label" text DEFAULT '' NOT NULL,
	"top_frame" text NOT NULL,
	"workflow_state" text DEFAULT 'triage' NOT NULL,
	"priority" integer DEFAULT 3 NOT NULL,
	"severity" text,
	"severity_source" text,
	"assigned_actor_id" text,
	"lease_holder_actor_id" text,
	"lease_expires_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"notes" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"occurrence_count" integer DEFAULT 0 NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_actor_id" text,
	"snooze_until" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "error_notification_policies" (
	"org_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"destination_ids_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notify_on_first_seen" boolean DEFAULT true NOT NULL,
	"notify_on_regression" boolean DEFAULT true NOT NULL,
	"notify_on_resolve" boolean DEFAULT false NOT NULL,
	"notify_on_transition_in_review" boolean DEFAULT false NOT NULL,
	"notify_on_transition_done" boolean DEFAULT false NOT NULL,
	"notify_on_claim" boolean DEFAULT false NOT NULL,
	"min_occurrence_count" integer DEFAULT 1 NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_escalation_policies" (
	"org_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"rules_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_escalations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"severity" text NOT NULL,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	"run_id" text,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"dedupe_key" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_auth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"initiated_by_user_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"return_to" text,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_user_id" text NOT NULL,
	"external_user_email" text,
	"connected_by_user_id" text NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"access_token_ciphertext" text NOT NULL,
	"access_token_iv" text NOT NULL,
	"access_token_tag" text NOT NULL,
	"refresh_token_ciphertext" text,
	"refresh_token_iv" text,
	"refresh_token_tag" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_onboarding_state" (
	"org_id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"email" text,
	"role" text,
	"demo_data_requested" boolean DEFAULT false NOT NULL,
	"onboarding_completed_at" timestamp with time zone,
	"checklist_dismissed_at" timestamp with time zone,
	"first_data_received_at" timestamp with time zone,
	"welcome_email_sent_at" timestamp with time zone,
	"connect_nudge_email_sent_at" timestamp with time zone,
	"stalled_email_sent_at" timestamp with time zone,
	"activation_email_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_ingest_attribute_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"source_context" text NOT NULL,
	"source_key" text NOT NULL,
	"target_key" text NOT NULL,
	"operation" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_recommendation_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"number" integer NOT NULL,
	"recommendation_key" text NOT NULL,
	"kind" text NOT NULL,
	"source_key" text NOT NULL,
	"canonical_key" text,
	"status" text DEFAULT 'open' NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "org_ingest_keys" (
	"org_id" text NOT NULL,
	"public_key" text NOT NULL,
	"public_key_hash" text NOT NULL,
	"private_key_ciphertext" text NOT NULL,
	"private_key_iv" text NOT NULL,
	"private_key_tag" text NOT NULL,
	"private_key_hash" text NOT NULL,
	"public_rotated_at" timestamp with time zone NOT NULL,
	"private_rotated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "org_ingest_keys_org_id_pk" PRIMARY KEY("org_id")
);
--> statement-breakpoint
CREATE TABLE "org_ingest_sampling_policies" (
	"org_id" text PRIMARY KEY NOT NULL,
	"trace_sample_ratio" double precision DEFAULT 1 NOT NULL,
	"always_keep_error_spans" boolean DEFAULT true NOT NULL,
	"always_keep_slow_spans_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_clickhouse_settings" (
	"org_id" text NOT NULL,
	"ch_url" text NOT NULL,
	"ch_user" text NOT NULL,
	"ch_password_ciphertext" text,
	"ch_password_iv" text,
	"ch_password_tag" text,
	"ch_database" text NOT NULL,
	"sync_status" text NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_sync_error" text,
	"schema_version" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "org_clickhouse_settings_org_id_pk" PRIMARY KEY("org_id")
);
--> statement-breakpoint
CREATE TABLE "org_clickhouse_schema_apply_runs" (
	"org_id" text NOT NULL,
	"workflow_instance_id" text,
	"status" text NOT NULL,
	"phase" text,
	"current_migration" integer,
	"steps_total" integer,
	"steps_done" integer,
	"applied_versions" jsonb,
	"skipped" jsonb,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "org_clickhouse_schema_apply_runs_org_id_pk" PRIMARY KEY("org_id")
);
--> statement-breakpoint
CREATE TABLE "scrape_target_checks" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "scrape_target_checks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"target_id" text NOT NULL,
	"org_id" text NOT NULL,
	"sub_target_key" text DEFAULT '' NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"error" text,
	"duration_ms" integer,
	"samples_scraped" integer,
	"samples_post_relabel" integer
);
--> statement-breakpoint
CREATE TABLE "scrape_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"service_name" text,
	"url" text NOT NULL,
	"target_type" text DEFAULT 'prometheus' NOT NULL,
	"discovery_config_json" jsonb,
	"scrape_interval_seconds" integer DEFAULT 15 NOT NULL,
	"labels_json" jsonb,
	"auth_type" text DEFAULT 'none' NOT NULL,
	"auth_credentials_ciphertext" text,
	"auth_credentials_iv" text,
	"auth_credentials_tag" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_scrape_at" timestamp with time zone,
	"last_scrape_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vcs_commits" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"repository_id" text NOT NULL,
	"sha" text NOT NULL,
	"message" text NOT NULL,
	"author_name" text,
	"author_email" text,
	"author_login" text,
	"author_avatar_url" text,
	"authored_at" timestamp with time zone,
	"committed_at" timestamp with time zone NOT NULL,
	"html_url" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vcs_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_installation_id" text NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"external_account_id" text NOT NULL,
	"account_avatar_url" text,
	"repository_selection" text DEFAULT 'all' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"suspended_at" timestamp with time zone,
	"installed_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vcs_repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"installation_id" text NOT NULL,
	"external_repo_id" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"tracked_branch" text,
	"html_url" text NOT NULL,
	"is_private" boolean DEFAULT true NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"sync_status" text DEFAULT 'pending' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_sync_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vcs_repository_branches" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"repository_id" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"head_sha" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scrape_target_checks" ADD CONSTRAINT "scrape_target_checks_target_id_scrape_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."scrape_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_triage_runs_incident_idx" ON "ai_triage_runs" USING btree ("org_id","incident_kind","incident_id");--> statement-breakpoint
CREATE INDEX "ai_triage_runs_org_issue_idx" ON "ai_triage_runs" USING btree ("org_id","issue_id");--> statement-breakpoint
CREATE INDEX "ai_triage_runs_org_created_idx" ON "ai_triage_runs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "alert_delivery_events_org_idx" ON "alert_delivery_events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "alert_delivery_events_org_incident_idx" ON "alert_delivery_events" USING btree ("org_id","incident_id");--> statement-breakpoint
CREATE INDEX "alert_delivery_events_due_idx" ON "alert_delivery_events" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "alert_delivery_events_claim_idx" ON "alert_delivery_events" USING btree ("status","claim_expires_at","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_delivery_events_delivery_attempt_idx" ON "alert_delivery_events" USING btree ("delivery_key","attempt_number");--> statement-breakpoint
CREATE INDEX "alert_destinations_org_idx" ON "alert_destinations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "alert_destinations_org_enabled_idx" ON "alert_destinations" USING btree ("org_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_destinations_org_name_idx" ON "alert_destinations" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "alert_incidents_org_idx" ON "alert_incidents" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "alert_incidents_org_status_idx" ON "alert_incidents" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "alert_incidents_org_rule_idx" ON "alert_incidents" USING btree ("org_id","rule_id");--> statement-breakpoint
CREATE INDEX "alert_incidents_org_issue_idx" ON "alert_incidents" USING btree ("org_id","error_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_incidents_incident_key_idx" ON "alert_incidents" USING btree ("incident_key");--> statement-breakpoint
CREATE INDEX "alert_rule_states_org_idx" ON "alert_rule_states" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "alert_rules_org_idx" ON "alert_rules" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "alert_rules_org_enabled_idx" ON "alert_rules" USING btree ("org_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_rules_org_name_idx" ON "alert_rules" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "anomaly_detector_states_org_idx" ON "anomaly_detector_states" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "anomaly_detector_states_open_incident_idx" ON "anomaly_detector_states" USING btree ("org_id","open_incident_id");--> statement-breakpoint
CREATE INDEX "anomaly_detector_states_evaluated_idx" ON "anomaly_detector_states" USING btree ("last_evaluated_at");--> statement-breakpoint
CREATE INDEX "anomaly_incidents_org_status_idx" ON "anomaly_incidents" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "anomaly_incidents_org_triggered_idx" ON "anomaly_incidents" USING btree ("org_id","last_triggered_at");--> statement-breakpoint
CREATE INDEX "anomaly_incidents_org_detector_idx" ON "anomaly_incidents" USING btree ("org_id","detector_key");--> statement-breakpoint
CREATE INDEX "anomaly_incidents_org_issue_idx" ON "anomaly_incidents" USING btree ("org_id","error_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_unique" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_org_id_idx" ON "api_keys" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "cloudflare_logpush_connectors_org_idx" ON "cloudflare_logpush_connectors" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "cloudflare_logpush_connectors_org_enabled_idx" ON "cloudflare_logpush_connectors" USING btree ("org_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "cloudflare_logpush_connectors_secret_hash_unique" ON "cloudflare_logpush_connectors" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "dashboard_versions_org_dashboard_idx" ON "dashboard_versions" USING btree ("org_id","dashboard_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_versions_org_dashboard_version_unq" ON "dashboard_versions" USING btree ("org_id","dashboard_id","version_number");--> statement-breakpoint
CREATE INDEX "dashboards_org_updated_idx" ON "dashboards" USING btree ("org_id","updated_at");--> statement-breakpoint
CREATE INDEX "dashboards_org_name_idx" ON "dashboards" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "digest_subscriptions_org_user_idx" ON "digest_subscriptions" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "digest_subscriptions_org_enabled_idx" ON "digest_subscriptions" USING btree ("org_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "actors_org_user_idx" ON "actors" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "actors_org_agent_name_idx" ON "actors" USING btree ("org_id","agent_name");--> statement-breakpoint
CREATE INDEX "actors_org_type_idx" ON "actors" USING btree ("org_id","type");--> statement-breakpoint
CREATE INDEX "error_incidents_org_issue_idx" ON "error_incidents" USING btree ("org_id","issue_id");--> statement-breakpoint
CREATE INDEX "error_incidents_org_status_idx" ON "error_incidents" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "error_issue_events_issue_idx" ON "error_issue_events" USING btree ("org_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "error_issue_events_actor_idx" ON "error_issue_events" USING btree ("org_id","actor_id","created_at");--> statement-breakpoint
CREATE INDEX "error_issue_events_type_idx" ON "error_issue_events" USING btree ("org_id","type","created_at");--> statement-breakpoint
CREATE INDEX "error_issue_states_org_idx" ON "error_issue_states" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "error_issues_org_fp_idx" ON "error_issues" USING btree ("org_id","fingerprint_hash");--> statement-breakpoint
CREATE INDEX "error_issues_org_workflow_idx" ON "error_issues" USING btree ("org_id","workflow_state");--> statement-breakpoint
CREATE INDEX "error_issues_org_severity_idx" ON "error_issues" USING btree ("org_id","severity");--> statement-breakpoint
CREATE INDEX "error_issues_org_last_seen_idx" ON "error_issues" USING btree ("org_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "error_issues_org_assignee_idx" ON "error_issues" USING btree ("org_id","assigned_actor_id");--> statement-breakpoint
CREATE INDEX "error_issues_lease_expiry_idx" ON "error_issues" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_escalations_dedupe_idx" ON "issue_escalations" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "issue_escalations_due_idx" ON "issue_escalations" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "issue_escalations_org_issue_idx" ON "issue_escalations" USING btree ("org_id","issue_id");--> statement-breakpoint
CREATE INDEX "oauth_auth_states_expires_idx" ON "oauth_auth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_connections_org_provider_idx" ON "oauth_connections" USING btree ("org_id","provider");--> statement-breakpoint
CREATE INDEX "oauth_connections_org_idx" ON "oauth_connections" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "org_ingest_attribute_mappings_org_idx" ON "org_ingest_attribute_mappings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "org_recommendation_issues_org_idx" ON "org_recommendation_issues" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_recommendation_issues_org_key_idx" ON "org_recommendation_issues" USING btree ("org_id","recommendation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "org_ingest_keys_public_key_unique" ON "org_ingest_keys" USING btree ("public_key");--> statement-breakpoint
CREATE UNIQUE INDEX "org_ingest_keys_public_key_hash_unique" ON "org_ingest_keys" USING btree ("public_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "org_ingest_keys_private_key_hash_unique" ON "org_ingest_keys" USING btree ("private_key_hash");--> statement-breakpoint
CREATE INDEX "scrape_target_checks_target_checked_idx" ON "scrape_target_checks" USING btree ("target_id","checked_at");--> statement-breakpoint
CREATE INDEX "scrape_targets_org_idx" ON "scrape_targets" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "scrape_targets_org_enabled_idx" ON "scrape_targets" USING btree ("org_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "vcs_commits_repo_sha_idx" ON "vcs_commits" USING btree ("repository_id","sha");--> statement-breakpoint
CREATE INDEX "vcs_commits_org_sha_idx" ON "vcs_commits" USING btree ("org_id","sha");--> statement-breakpoint
CREATE UNIQUE INDEX "vcs_installations_provider_external_idx" ON "vcs_installations" USING btree ("provider","external_installation_id");--> statement-breakpoint
CREATE INDEX "vcs_installations_org_idx" ON "vcs_installations" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vcs_repositories_org_repo_idx" ON "vcs_repositories" USING btree ("org_id","provider","external_repo_id");--> statement-breakpoint
CREATE INDEX "vcs_repositories_org_idx" ON "vcs_repositories" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "vcs_repositories_installation_idx" ON "vcs_repositories" USING btree ("installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vcs_repository_branches_repo_name_idx" ON "vcs_repository_branches" USING btree ("repository_id","name");--> statement-breakpoint
CREATE INDEX "vcs_repository_branches_org_idx" ON "vcs_repository_branches" USING btree ("org_id");