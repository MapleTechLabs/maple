import type {
	AlertDestinationRow,
	AlertIncidentRow,
	AlertRuleRow,
	AlertRuleStateRow,
} from "@maple/web-data/collections/alerts"
import { isoMs } from "./time"

// Synced alert rows for the alerts pages' scene tests, the shape Electric delivers.

export const ORG = "org_acme"
export const NOW = isoMs("2026-10-01T12:00:00.000Z")
const iso = (msBefore: number) => new Date(NOW - msBefore).toISOString()
const MINUTE = 60_000

export const ruleId = (n: number) => `0199a002-0000-7000-8000-00000000000${n}`
export const DESTINATION_ID = "0199a001-0000-7000-8000-000000000001"
export const INCIDENT_ID = "0199a003-0000-7000-8000-000000000001"

export const ruleRow = (n: number, fields: Partial<AlertRuleRow> = {}): AlertRuleRow => ({
	id: ruleId(n),
	org_id: ORG,
	name: `Rule ${n}`,
	notes: null,
	notification_template_json: null,
	enabled: true,
	severity: "critical",
	service_names_json: ["payment-svc"],
	exclude_service_names_json: [],
	environments_json: ["production"],
	tags_json: [],
	signal_type: "p95_latency",
	comparator: "gt",
	threshold: 800,
	threshold_upper: null,
	window_minutes: 5,
	minimum_sample_count: 10,
	consecutive_breaches_required: 2,
	consecutive_healthy_required: 2,
	renotify_interval_minutes: 60,
	apdex_threshold_ms: null,
	query_builder_draft_json: null,
	raw_query_sql: null,
	reducer: "identity",
	group_by: null,
	destination_ids_json: [DESTINATION_ID],
	query_spec_json: null,
	sample_count_strategy: null,
	no_data_behavior: "skip",
	last_scheduled_at: iso(MINUTE),
	created_at: iso(14 * 24 * 60 * MINUTE),
	updated_at: iso(3 * 24 * 60 * MINUTE),
	created_by: "user_ada",
	updated_by: "user_ada",
	...fields,
})

export const stateRow = (n: number, fields: Partial<AlertRuleStateRow> = {}): AlertRuleStateRow => ({
	org_id: ORG,
	rule_id: ruleId(n),
	group_key: "all",
	consecutive_breaches: 0,
	consecutive_healthy: 40,
	last_status: "healthy",
	last_value: 400,
	last_sample_count: 300,
	last_evaluated_at: iso(MINUTE),
	last_error: null,
	updated_at: iso(MINUTE),
	...fields,
})

export const incidentRow = (fields: Partial<AlertIncidentRow> = {}): AlertIncidentRow => ({
	id: INCIDENT_ID,
	org_id: ORG,
	rule_id: ruleId(2),
	incident_key: "rule-2:all",
	rule_name: "Rule 2",
	group_key: "all",
	signal_type: "p95_latency",
	severity: "critical",
	status: "open",
	comparator: "gt",
	threshold: 800,
	threshold_upper: null,
	first_triggered_at: iso(110 * MINUTE),
	last_triggered_at: iso(MINUTE),
	resolved_at: null,
	last_observed_value: 1840.5,
	last_sample_count: 312,
	last_evaluated_at: iso(MINUTE),
	dedupe_key: "rule-2:all",
	last_delivered_event_type: "trigger",
	last_notified_at: iso(50 * MINUTE),
	hold_reason: null,
	held_since: null,
	error_issue_id: null,
	created_at: iso(110 * MINUTE),
	updated_at: iso(MINUTE),
	...fields,
})

export const destinationRow = (fields: Partial<AlertDestinationRow> = {}): AlertDestinationRow => ({
	id: DESTINATION_ID,
	org_id: ORG,
	name: "On-call webhook",
	type: "webhook",
	enabled: true,
	config_json: { summary: "https://hooks.acme.test/maple", channelLabel: null },
	last_tested_at: iso(5 * 24 * 60 * MINUTE),
	last_test_error: null,
	disabled_at: null,
	disabled_reason: null,
	created_at: iso(30 * 24 * 60 * MINUTE),
	updated_at: iso(5 * 24 * 60 * MINUTE),
	...fields,
})
