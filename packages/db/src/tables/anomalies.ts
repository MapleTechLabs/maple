import * as PG from "@maple-dev/effect-orm/postgres"
import {
	AnomalyIncidentSeverity,
	AnomalyIncidentStatus,
	AnomalyResolveReason,
	AnomalySensitivity,
	AnomalySignalType,
	AnomalyTriageStatus,
} from "@maple/domain/http"
import { AnomalyIncidentId, ErrorIssueId, OrgId, UserId } from "@maple/domain/primitives"
import { Schema } from "effect"

/**
 * One row per org. Doubles as the org-level claim lock for the anomaly
 * detector tick (CAS on lastTickAt, mirroring alert_rules.lastScheduledAt).
 * The detector is zero-config: a missing row means defaults (enabled).
 */
export const AnomalyDetectorSettings = PG.table("anomaly_detector_settings", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		enabled: PG.column(PG.bool, { default: true }),
		sensitivity: PG.column(PG.brand(PG.text, AnomalySensitivity), { default: "normal" }),
		mutedSignalsJson: PG.column(PG.jsonb(Schema.Array(Schema.String)), { name: "muted_signals_json", default: [] }),
		lastTickAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_tick_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		updatedBy: PG.column(PG.nullable(PG.brand(PG.text, UserId)), { name: "updated_by" }),
	},
	primaryKey: ["orgId"],
	tenantColumn: "orgId",
})

/**
 * Hysteresis + cooldown state per detector series (clone of the
 * alert_rule_states mechanics, keyed by detectorKey instead of rule/group).
 * detectorKey = `${signalType}:${deploymentEnv}:${serviceName}` or
 * `error_spike:${deploymentEnv}:${fingerprintHash}`.
 */
export const AnomalyDetectorStates = PG.table("anomaly_detector_states", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		detectorKey: PG.column(PG.text, { name: "detector_key" }),
		signalType: PG.column(PG.brand(PG.text, AnomalySignalType), { name: "signal_type" }),
		serviceName: PG.column(PG.text, { name: "service_name" }),
		deploymentEnv: PG.column(PG.text, { name: "deployment_env", default: "" }),
		fingerprintHash: PG.column(PG.nullable(PG.text), { name: "fingerprint_hash" }),
		consecutiveBreaches: PG.column(PG.int4, { name: "consecutive_breaches", default: 0 }),
		consecutiveHealthy: PG.column(PG.int4, { name: "consecutive_healthy", default: 0 }),
		lastStatus: PG.column(PG.nullable(PG.text), { name: "last_status" }),
		lastValue: PG.column(PG.nullable(PG.float8), { name: "last_value" }),
		baselineMedian: PG.column(PG.nullable(PG.float8), { name: "baseline_median" }),
		lastSampleCount: PG.column(PG.nullable(PG.int4), { name: "last_sample_count" }),
		lastEvaluatedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_evaluated_at" }),
		openIncidentId: PG.column(PG.nullable(PG.brand(PG.text, AnomalyIncidentId)), { name: "open_incident_id" }),
		lastResolvedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_resolved_at" }),
		/** Most recent incident this series opened or fed; reopen target after a resolve. */
		lastIncidentId: PG.column(PG.nullable(PG.brand(PG.text, AnomalyIncidentId)), { name: "last_incident_id" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: {
		columns: ["orgId", "detectorKey"],
		name: "anomaly_detector_states_org_id_detector_key_pk",
	},
	indexes: [
		// No standalone org_id index: the primary key already leads with org_id,
		// so one was pure write amplification on ~130k upserts a day.
		// Partial: every read of this index either equals a concrete incident id or
		// asks for the open slice, and open rows are a small fraction of the table.
		PG.index("anomaly_detector_states_open_incident_idx", ["orgId", "openIncidentId"], {
			where: `"open_incident_id" is not null`,
		}),
		PG.index("anomaly_detector_states_evaluated_idx", ["lastEvaluatedAt"]),
	],
	tenantColumn: "orgId",
})

/**
 * An anomaly flare-up for one detector series. Self-explaining: carries the
 * observed value, baseline stats, and threshold at open time so the UI and
 * the AI triage prompt can describe the deviation without re-querying.
 */
export const AnomalyIncidents = PG.table("anomaly_incidents", {
	columns: {
		id: PG.brand(PG.text, AnomalyIncidentId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		detectorKey: PG.column(PG.text, { name: "detector_key" }),
		signalType: PG.column(PG.brand(PG.text, AnomalySignalType), { name: "signal_type" }),
		serviceName: PG.column(PG.text, { name: "service_name" }),
		deploymentEnv: PG.column(PG.text, { name: "deployment_env", default: "" }),
		fingerprintHash: PG.column(PG.nullable(PG.text), { name: "fingerprint_hash" }),
		errorIssueId: PG.column(PG.nullable(PG.brand(PG.text, ErrorIssueId)), { name: "error_issue_id" }),
		status: PG.brand(PG.text, AnomalyIncidentStatus),
		severity: PG.brand(PG.text, AnomalyIncidentSeverity),
		openedValue: PG.column(PG.float8, { name: "opened_value" }),
		baselineMedian: PG.column(PG.float8, { name: "baseline_median" }),
		baselineSigma: PG.column(PG.float8, { name: "baseline_sigma" }),
		thresholdValue: PG.column(PG.float8, { name: "threshold_value" }),
		lastObservedValue: PG.column(PG.float8, { name: "last_observed_value" }),
		lastSampleCount: PG.column(PG.int4, { name: "last_sample_count", default: 0 }),
		firstTriggeredAt: PG.column(PG.timestamptzMillis, { name: "first_triggered_at" }),
		lastTriggeredAt: PG.column(PG.timestamptzMillis, { name: "last_triggered_at" }),
		resolvedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "resolved_at" }),
		resolveReason: PG.column(PG.nullable(PG.brand(PG.text, AnomalyResolveReason)), { name: "resolve_reason" }),
		triageStatus: PG.column(PG.brand(PG.text, AnomalyTriageStatus), { name: "triage_status", default: "none" }),
		dedupeKey: PG.column(PG.text, { name: "dedupe_key" }),
		/**
		 * Error-spike consolidation: all fingerprints sharing this incident
		 * (JSON array of IncidentFingerprintEntry; empty for golden signals).
		 */
		fingerprintsJson: PG.column(PG.jsonb(Schema.Array(Schema.Unknown)), { name: "fingerprints_json", default: [] }),
		/** Times this incident re-breached and reopened within the reopen window. */
		reopenCount: PG.column(PG.int4, { name: "reopen_count", default: 0 }),
		lastReopenedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_reopened_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		// (org, status) plus the list ordering: listIncidents filters on the
		// first two and orders by (last_triggered_at DESC, id DESC), so a
		// backward index walk answers the page directly (SELECT
		// anomaly_incidents was ~970ms p95 sorting the org's rows by hand).
		// Replaces anomaly_incidents_org_status_idx, whose prefix this carries.
		PG.index("anomaly_incidents_org_status_triggered_idx", ["orgId", "status", "lastTriggeredAt", "id"]),
		PG.index("anomaly_incidents_org_triggered_idx", ["orgId", "lastTriggeredAt"]),
		PG.index("anomaly_incidents_org_detector_idx", ["orgId", "detectorKey"]),
		PG.index("anomaly_incidents_org_issue_idx", ["orgId", "errorIssueId"]),
		// One open incident per detector: the org claim is a bare lastTickAt CAS
		// with no renewal, so a tick that outruns ORG_LOCK_TTL_MS can overlap the
		// next one; this turns the duplicate open into a no-op/loud conflict
		// instead of two incidents, two triages, two pages.
		PG.uniqueIndex("anomaly_incidents_open_detector_idx", ["orgId", "detectorKey"], {
			where: ($) => $.status.eq("open"),
		}),
	],
	tenantColumn: "orgId",
})

export type AnomalyDetectorSettingsRow = PG.SelectRowOf<typeof AnomalyDetectorSettings>
export type AnomalyDetectorStateRow = PG.SelectRowOf<typeof AnomalyDetectorStates>
export type AnomalyDetectorStateInsert = PG.InsertRowOf<typeof AnomalyDetectorStates>
export type AnomalyIncidentRow = PG.SelectRowOf<typeof AnomalyIncidents>
export type AnomalyIncidentInsert = PG.InsertRowOf<typeof AnomalyIncidents>
