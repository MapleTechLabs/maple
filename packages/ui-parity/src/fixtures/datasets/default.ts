import type { Dataset, SyncedRow } from "../dataset.ts"
import { acmeAdmin, DAY, FROZEN_NOW, fixtureUuid, HOUR, isoBefore, MINUTE } from "../identity.ts"
import { acmeShopTelemetry } from "../telemetry/acme-shop.ts"

/**
 * Acme Shop: six services over the last 24 h with the payment-svc 3.5.0 pool-exhaustion incident,
 * logs and metrics, plus a few dashboards, alert rules and an open incident.
 */

const org = acmeAdmin.orgId
const user = acmeAdmin.userId

const dashboard = (index: number, name: string, ageMs: number): SyncedRow => {
	const id = `dash_parity_${index}`
	const createdAt = isoBefore(ageMs)
	const updatedAt = isoBefore(ageMs / 2)
	return {
		org_id: org,
		id,
		name,
		payload_json: {
			id,
			name,
			timeRange: { type: "relative", value: "12h" },
			widgets: [],
			createdAt,
			updatedAt,
		},
		created_at: createdAt,
		updated_at: updatedAt,
		created_by: user,
		updated_by: user,
		version: 1,
	}
}

const destinationId = fixtureUuid(1, 1)

const rule = (
	index: number,
	fields: {
		readonly name: string
		readonly severity: "warning" | "critical"
		readonly signal: string
		readonly threshold: number
		readonly services: ReadonlyArray<string>
		readonly enabled?: boolean
	},
): SyncedRow => ({
	id: fixtureUuid(2, index),
	org_id: org,
	name: fields.name,
	notes: null,
	notification_template_json: null,
	enabled: fields.enabled ?? true,
	severity: fields.severity,
	service_names_json: fields.services,
	exclude_service_names_json: [],
	environments_json: ["production"],
	tags_json: [],
	signal_type: fields.signal,
	comparator: "gt",
	threshold: fields.threshold,
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
	destination_ids_json: [destinationId],
	query_spec_json: null,
	sample_count_strategy: null,
	no_data_behavior: "skip",
	last_scheduled_at: isoBefore(MINUTE),
	created_at: isoBefore(14 * DAY),
	updated_at: isoBefore(3 * DAY),
	created_by: user,
	updated_by: user,
})

const paymentLatencyRule = rule(2, {
	name: "Payment p95 latency",
	severity: "critical",
	signal: "p95_latency",
	threshold: 800,
	services: ["payment-svc"],
})

const rules = [
	rule(1, { name: "Checkout error rate", severity: "critical", signal: "error_rate", threshold: 2, services: ["checkout-api"] }),
	paymentLatencyRule,
	rule(3, { name: "Storefront p99 latency", severity: "warning", signal: "p99_latency", threshold: 1500, services: ["storefront"] }),
	rule(4, { name: "Catalog error rate", severity: "warning", signal: "error_rate", threshold: 5, services: ["catalog-api"], enabled: false }),
]

/** Payment p95 has been breaching since the 3.5.0 rollout; everything else is healthy. */
const ruleStates: ReadonlyArray<SyncedRow> = rules.map((row, index) => ({
	org_id: org,
	rule_id: row.id,
	group_key: "all",
	consecutive_breaches: index === 1 ? 23 : 0,
	consecutive_healthy: index === 1 ? 0 : 40,
	last_status: index === 1 ? "breached" : "healthy",
	last_value: index === 1 ? 1840.5 : 0.4,
	last_sample_count: 312,
	last_evaluated_at: isoBefore(MINUTE),
	last_error: null,
	updated_at: isoBefore(MINUTE),
}))

const incidents: ReadonlyArray<SyncedRow> = [
	{
		id: fixtureUuid(3, 1),
		org_id: org,
		rule_id: paymentLatencyRule.id,
		incident_key: "payment-p95:all",
		rule_name: "Payment p95 latency",
		group_key: "all",
		signal_type: "p95_latency",
		severity: "critical",
		status: "open",
		comparator: "gt",
		threshold: 800,
		threshold_upper: null,
		first_triggered_at: isoBefore(110 * MINUTE),
		last_triggered_at: isoBefore(MINUTE),
		resolved_at: null,
		last_observed_value: 1840.5,
		last_sample_count: 312,
		last_evaluated_at: isoBefore(MINUTE),
		dedupe_key: "payment-p95:all",
		last_delivered_event_type: "trigger",
		last_notified_at: isoBefore(50 * MINUTE),
		hold_reason: null,
		held_since: null,
		error_issue_id: null,
		created_at: isoBefore(110 * MINUTE),
		updated_at: isoBefore(MINUTE),
	},
]

const destination: SyncedRow = {
	id: destinationId,
	org_id: org,
	name: "On-call webhook",
	type: "webhook",
	enabled: true,
	config_json: { summary: "https://hooks.acme.test/maple", channelLabel: null },
	last_tested_at: isoBefore(5 * DAY),
	last_test_error: null,
	disabled_at: null,
	disabled_reason: null,
	created_at: isoBefore(30 * DAY),
	updated_at: isoBefore(5 * DAY),
}

export const defaultDataset: Dataset = {
	name: "default",
	now: FROZEN_NOW,
	identity: acmeAdmin,
	auth: "self_hosted",
	endpoints: {},
	synced: {
		dashboards: [
			dashboard(1, "Checkout health", 20 * DAY),
			dashboard(2, "Payments incident review", 2 * HOUR),
			dashboard(3, "Storefront web vitals", 45 * DAY),
		],
		alert_rules: rules,
		alert_rule_states: ruleStates,
		alert_incidents: incidents,
		alert_destinations: [destination],
		alert_destinations_v2: [destination],
		api_keys: [],
	},
	telemetry: acmeShopTelemetry({
		orgId: org,
		now: new Date(FROZEN_NOW),
		hours: 24,
		peakTracesPerMinute: 6,
		seed: 7,
	}),
}
