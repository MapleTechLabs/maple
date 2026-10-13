import * as PG from "@maple-dev/effect-orm/postgres"
import {
	AlertDeliveryEventId,
	AlertDestinationId,
	AlertIncidentId,
	AlertRuleId,
	ErrorIssueId,
	OrgId,
} from "@maple/domain/primitives"
import { Schema } from "effect"

const StringArray = Schema.Array(Schema.String)

export const AlertDestinations = PG.table("alert_destinations", {
	columns: {
		id: PG.brand(PG.text, AlertDestinationId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		name: PG.text,
		type: PG.text,
		enabled: PG.column(PG.bool, { default: true }),
		configJson: PG.column(PG.jsonb(), { name: "config_json" }),
		secretCiphertext: PG.column(PG.text, { name: "secret_ciphertext" }),
		secretIv: PG.column(PG.text, { name: "secret_iv" }),
		secretTag: PG.column(PG.text, { name: "secret_tag" }),
		lastTestedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_tested_at" }),
		lastTestError: PG.column(PG.nullable(PG.text), { name: "last_test_error" }),
		/**
		 * Consecutive *terminal* delivery failures (`retry: "never"`: a provider
		 * 4xx, revoked credentials, a deleted channel). Reset to 0 by any
		 * successful delivery and by an edit that could have fixed the config.
		 * A retryable failure (5xx/429/timeout) does not touch it: those are the
		 * provider having a bad minute, not the destination being broken.
		 */
		consecutiveFailures: PG.column(PG.int4, { name: "consecutive_failures", default: 0 }),
		lastFailureAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_failure_at" }),
		/** Set when the counter crossed the auto-disable threshold. */
		disabledAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "disabled_at" }),
		disabledReason: PG.column(PG.nullable(PG.text), { name: "disabled_reason" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		createdBy: PG.column(PG.text, { name: "created_by" }),
		updatedBy: PG.column(PG.text, { name: "updated_by" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("alert_destinations_org_idx", ["orgId"]),
		PG.index("alert_destinations_org_enabled_idx", ["orgId", "enabled"]),
		PG.uniqueIndex("alert_destinations_org_name_idx", ["orgId", "name"]),
	],
	tenantColumn: "orgId",
})

export const AlertRules = PG.table("alert_rules", {
	columns: {
		id: PG.brand(PG.text, AlertRuleId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		name: PG.text,
		notes: PG.nullable(PG.text),
		notificationTemplateJson: PG.column(PG.nullable(PG.jsonb()), { name: "notification_template_json" }),
		enabled: PG.column(PG.bool, { default: true }),
		severity: PG.text,
		serviceNamesJson: PG.column(PG.nullable(PG.jsonb(StringArray)), { name: "service_names_json" }),
		excludeServiceNamesJson: PG.column(PG.nullable(PG.jsonb(StringArray)), {
			name: "exclude_service_names_json",
		}),
		/**
		 * Deployment environments the rule is scoped to. Null/empty means every
		 * environment. Applies to the built-in trace signals;
		 * `builder_query` / `raw_query` carry their own
		 * filters, so it is always empty for those.
		 */
		environmentsJson: PG.column(PG.nullable(PG.jsonb(StringArray)), { name: "environments_json" }),
		/** JSON-encoded `string[]` of free-form tags used to group and filter rules. */
		tagsJson: PG.column(PG.nullable(PG.jsonb(StringArray)), { name: "tags_json" }),
		signalType: PG.column(PG.text, { name: "signal_type" }),
		comparator: PG.text,
		threshold: PG.float8,
		thresholdUpper: PG.column(PG.nullable(PG.float8), { name: "threshold_upper" }),
		windowMinutes: PG.column(PG.int4, { name: "window_minutes" }),
		minimumSampleCount: PG.column(PG.int4, { name: "minimum_sample_count", default: 0 }),
		consecutiveBreachesRequired: PG.column(PG.int4, {
			name: "consecutive_breaches_required",
			default: 2,
		}),
		consecutiveHealthyRequired: PG.column(PG.int4, { name: "consecutive_healthy_required", default: 2 }),
		renotifyIntervalMinutes: PG.column(PG.int4, { name: "renotify_interval_minutes", default: 30 }),
		apdexThresholdMs: PG.column(PG.nullable(PG.float8), { name: "apdex_threshold_ms" }),
		queryBuilderDraftJson: PG.column(PG.nullable(PG.jsonb()), { name: "query_builder_draft_json" }),
		rawQuerySql: PG.column(PG.nullable(PG.text), { name: "raw_query_sql" }),
		groupBy: PG.column(PG.nullable(PG.text), { name: "group_by" }),
		destinationIdsJson: PG.column(PG.jsonb(StringArray), { name: "destination_ids_json" }),
		querySpecJson: PG.column(PG.nullable(PG.jsonb()), { name: "query_spec_json" }),
		reducer: PG.text,
		sampleCountStrategy: PG.column(PG.nullable(PG.text), { name: "sample_count_strategy" }),
		noDataBehavior: PG.column(PG.text, { name: "no_data_behavior" }),
		lastScheduledAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_scheduled_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		createdBy: PG.column(PG.text, { name: "created_by" }),
		updatedBy: PG.column(PG.text, { name: "updated_by" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("alert_rules_org_idx", ["orgId"]),
		PG.index("alert_rules_org_enabled_idx", ["orgId", "enabled"]),
		PG.uniqueIndex("alert_rules_org_name_idx", ["orgId", "name"]),
	],
	tenantColumn: "orgId",
})

/**
 * Scheduler claim lock: deliberately NOT a member of `electric_publication_default`.
 *
 * The alerting cron CAS-claims every enabled rule once a minute. That claim used to
 * be an `UPDATE alert_rules SET last_scheduled_at`, which is the worst possible table
 * to touch that often: `alert_rules` is the widest control-plane table (eight jsonb
 * columns plus `raw_query_sql`), it is Electric-synced, and it carried
 * `REPLICA IDENTITY FULL`, so each claim wrote the entire old row *and* the new row
 * into the WAL, shipped both out of PlanetScale to Electric Cloud, and fanned the row
 * out to every connected browser as a shape delta.
 *
 * Holding the lock in its own narrow, unpublished table keeps the per-minute write out
 * of the replication stream entirely. Electric runs with
 * ELECTRIC_MANUAL_TABLE_PUBLISHING=true (see 0009_electric_publication.sql), so a new
 * table is unpublished unless a migration explicitly adds it; do not add this one.
 */
export const AlertRuleClaims = PG.table("alert_rule_claims", {
	columns: {
		ruleId: PG.column(PG.brand(PG.text, AlertRuleId), { name: "rule_id" }),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		lastScheduledAt: PG.column(PG.timestamptzMillis, { name: "last_scheduled_at" }),
	},
	primaryKey: ["ruleId"],
	indexes: [PG.index("alert_rule_claims_org_idx", ["orgId"])],
	tenantColumn: "orgId",
})

export const AlertRuleStates = PG.table("alert_rule_states", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		ruleId: PG.column(PG.brand(PG.text, AlertRuleId), { name: "rule_id" }),
		groupKey: PG.column(PG.text, { name: "group_key", default: "__total__" }),
		consecutiveBreaches: PG.column(PG.int4, { name: "consecutive_breaches", default: 0 }),
		consecutiveHealthy: PG.column(PG.int4, { name: "consecutive_healthy", default: 0 }),
		lastStatus: PG.column(PG.nullable(PG.text), { name: "last_status" }),
		lastValue: PG.column(PG.nullable(PG.float8), { name: "last_value" }),
		lastSampleCount: PG.column(PG.nullable(PG.int4), { name: "last_sample_count" }),
		lastEvaluatedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_evaluated_at" }),
		lastError: PG.column(PG.nullable(PG.text), { name: "last_error" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: {
		columns: ["orgId", "ruleId", "groupKey"],
		name: "alert_rule_states_org_id_rule_id_group_key_pk",
	},
	indexes: [PG.index("alert_rule_states_org_idx", ["orgId"])],
	tenantColumn: "orgId",
})

export const AlertIncidents = PG.table("alert_incidents", {
	columns: {
		id: PG.brand(PG.text, AlertIncidentId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		ruleId: PG.column(PG.brand(PG.text, AlertRuleId), { name: "rule_id" }),
		incidentKey: PG.column(PG.text, { name: "incident_key" }),
		ruleName: PG.column(PG.text, { name: "rule_name" }),
		groupKey: PG.column(PG.nullable(PG.text), { name: "group_key" }),
		signalType: PG.column(PG.text, { name: "signal_type" }),
		severity: PG.text,
		status: PG.text,
		comparator: PG.text,
		threshold: PG.float8,
		thresholdUpper: PG.column(PG.nullable(PG.float8), { name: "threshold_upper" }),
		firstTriggeredAt: PG.column(PG.timestamptzMillis, { name: "first_triggered_at" }),
		lastTriggeredAt: PG.column(PG.timestamptzMillis, { name: "last_triggered_at" }),
		resolvedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "resolved_at" }),
		lastObservedValue: PG.column(PG.nullable(PG.float8), { name: "last_observed_value" }),
		lastSampleCount: PG.column(PG.nullable(PG.int4), { name: "last_sample_count" }),
		lastEvaluatedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_evaluated_at" }),
		dedupeKey: PG.column(PG.text, { name: "dedupe_key" }),
		lastDeliveredEventType: PG.column(PG.nullable(PG.text), { name: "last_delivered_event_type" }),
		lastNotifiedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_notified_at" }),
		// Set while an open incident is waiting on telemetry: the breach stopped
		// showing up but the liveness probe could not prove the data was still
		// flowing. Both are null once the incident is firing or resolved.
		holdReason: PG.column(PG.nullable(PG.text), { name: "hold_reason" }),
		heldSince: PG.column(PG.nullable(PG.timestamptzMillis), { name: "held_since" }),
		// Issue-hub link: the error_issues row (kind="alert") this incident
		// feeds, mirroring anomalyIncidents.errorIssueId.
		errorIssueId: PG.column(PG.nullable(PG.brand(PG.text, ErrorIssueId)), { name: "error_issue_id" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("alert_incidents_org_idx", ["orgId"]),
		PG.index("alert_incidents_org_status_idx", ["orgId", "status"]),
		PG.index("alert_incidents_org_rule_idx", ["orgId", "ruleId"]),
		PG.index("alert_incidents_org_issue_idx", ["orgId", "errorIssueId"]),
		PG.uniqueIndex("alert_incidents_incident_key_idx", ["incidentKey"]),
		// One open incident per (rule, group): the scheduler's claim serializes
		// rule evaluation in the common case, and this makes duplicate opens from
		// an expired claim impossible instead of merely unlikely. NULL groupKey
		// rows (pre-scheduler history) escape the constraint; the scheduler always
		// writes a string key.
		PG.uniqueIndex("alert_incidents_open_group_idx", ["orgId", "ruleId", "groupKey"], {
			where: ($) => $.status.eq("open"),
		}),
	],
	tenantColumn: "orgId",
})

export const AlertDeliveryEvents = PG.table("alert_delivery_events", {
	columns: {
		id: PG.brand(PG.text, AlertDeliveryEventId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		incidentId: PG.column(PG.nullable(PG.brand(PG.text, AlertIncidentId)), { name: "incident_id" }),
		ruleId: PG.column(PG.brand(PG.text, AlertRuleId), { name: "rule_id" }),
		destinationId: PG.column(PG.brand(PG.text, AlertDestinationId), { name: "destination_id" }),
		deliveryKey: PG.column(PG.text, { name: "delivery_key" }),
		eventType: PG.column(PG.text, { name: "event_type" }),
		attemptNumber: PG.column(PG.int4, { name: "attempt_number" }),
		status: PG.text,
		scheduledAt: PG.column(PG.timestamptzMillis, { name: "scheduled_at" }),
		claimedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "claimed_at" }),
		claimExpiresAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "claim_expires_at" }),
		claimedBy: PG.column(PG.nullable(PG.text), { name: "claimed_by" }),
		attemptedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "attempted_at" }),
		providerMessage: PG.column(PG.nullable(PG.text), { name: "provider_message" }),
		providerReference: PG.column(PG.nullable(PG.text), { name: "provider_reference" }),
		responseCode: PG.column(PG.nullable(PG.int4), { name: "response_code" }),
		errorMessage: PG.column(PG.nullable(PG.text), { name: "error_message" }),
		payloadJson: PG.column(PG.jsonb(), { name: "payload_json" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("alert_delivery_events_org_idx", ["orgId"]),
		PG.index("alert_delivery_events_org_incident_idx", ["orgId", "incidentId"]),
		PG.index("alert_delivery_events_due_idx", ["status", "scheduledAt"]),
		PG.index("alert_delivery_events_claim_idx", ["status", "claimExpiresAt", "scheduledAt"]),
		PG.uniqueIndex("alert_delivery_events_delivery_attempt_idx", ["deliveryKey", "attemptNumber"]),
	],
	tenantColumn: "orgId",
})

export type AlertDestinationRow = PG.SelectRowOf<typeof AlertDestinations>
export type AlertRuleRow = PG.SelectRowOf<typeof AlertRules>
export type AlertRuleStateRow = PG.SelectRowOf<typeof AlertRuleStates>
export type AlertIncidentRow = PG.SelectRowOf<typeof AlertIncidents>
export type AlertDeliveryEventRow = PG.SelectRowOf<typeof AlertDeliveryEvents>
