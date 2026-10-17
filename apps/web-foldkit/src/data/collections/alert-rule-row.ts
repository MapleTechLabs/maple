import { Schema } from "effect"

// copied from apps/web/src/lib/collections/alerts.ts: that module cannot be imported (its
// factories go through shape-fetch.ts and the React atom registry). Phase 1 splits the row
// schemas and `rowTo*` mappers into a framework-free module both apps import.

/** Identity row schema for `alert_rules`, snake_case like the pgTable. */
export const AlertRuleRowSchema = Schema.Struct({
	id: Schema.String,
	org_id: Schema.String,
	name: Schema.String,
	notes: Schema.NullOr(Schema.String),
	notification_template_json: Schema.NullOr(Schema.Unknown),
	enabled: Schema.Boolean,
	severity: Schema.String,
	service_names_json: Schema.NullOr(Schema.Unknown),
	exclude_service_names_json: Schema.NullOr(Schema.Unknown),
	environments_json: Schema.NullOr(Schema.Unknown),
	tags_json: Schema.NullOr(Schema.Unknown),
	signal_type: Schema.String,
	comparator: Schema.String,
	threshold: Schema.Number,
	threshold_upper: Schema.NullOr(Schema.Number),
	window_minutes: Schema.Number,
	minimum_sample_count: Schema.Number,
	consecutive_breaches_required: Schema.Number,
	consecutive_healthy_required: Schema.Number,
	renotify_interval_minutes: Schema.Number,
	apdex_threshold_ms: Schema.NullOr(Schema.Number),
	query_builder_draft_json: Schema.NullOr(Schema.Unknown),
	raw_query_sql: Schema.NullOr(Schema.String),
	reducer: Schema.String,
	group_by: Schema.NullOr(Schema.String),
	destination_ids_json: Schema.Unknown,
	query_spec_json: Schema.NullOr(Schema.Unknown),
	sample_count_strategy: Schema.NullOr(Schema.String),
	no_data_behavior: Schema.String,
	last_scheduled_at: Schema.NullOr(Schema.String),
	created_at: Schema.String,
	updated_at: Schema.String,
	created_by: Schema.String,
	updated_by: Schema.String,
})
export type AlertRuleRow = typeof AlertRuleRowSchema.Type

/** `timestamptzParser` (`shape-fetch.ts`): Postgres timestamptz text to ISO. */
export const timestamptzParser = { timestamptz: (value: string) => new Date(value).toISOString() }
