import { AnomalyIncidentId, ErrorIssueId } from "@maple/domain/http"
import {
	encodePublicId,
	PublicIdPrefixes,
	V2AnomalyIncident,
	V2AnomalyIncidentTimeseries,
} from "@maple/domain/http/v2"
import type { AlertIncidentRow, AlertRuleRow } from "@maple/web-data/collections/alerts"
import { Array as Arr, Schema } from "effect"
import { DESTINATION_ID, incidentRow, NOW, ruleId, ruleRow } from "./test-rows"

// Anomaly rules, their alert incidents and the detector's anomaly behind one, for the scene tests
// and `/lab/anomaly-alerts`.

const MINUTE = 60_000
const iso = (msBefore: number) => new Date(NOW - msBefore).toISOString()

export const anomalyId = (n: number) =>
	Schema.decodeSync(AnomalyIncidentId)(`0199a060-0000-7000-8000-00000000000${n}`)
export const anomalyAlertIncidentId = (n: number) => `0199a003-0000-7000-8000-0000000000a${n}`
const ISSUE_ID = Schema.decodeSync(ErrorIssueId)("0199a070-0000-7000-8000-000000000001")

const TIERS = (warning: ReadonlyArray<string>, critical: ReadonlyArray<string>) => [
	{ severity: "warning", value: 1, upper: null, recoveryValue: null, destinationIds: warning },
	{ severity: "critical", value: 2, upper: null, recoveryValue: null, destinationIds: critical },
]

/** An anomaly rule's synced row; no scope fields makes it the org's default rule. */
export const anomalyRuleRow = (
	n: number,
	fields: Partial<AlertRuleRow> & {
		readonly warningIds?: ReadonlyArray<string>
		readonly criticalIds?: ReadonlyArray<string>
	} = {},
): AlertRuleRow => {
	const { warningIds = [], criticalIds = [], ...rest } = fields
	return ruleRow(n, {
		name: "Anomaly detection",
		severity: "critical",
		signal_type: "anomaly",
		service_names_json: null,
		exclude_service_names_json: null,
		environments_json: null,
		anomaly_signals_json: null,
		comparator: "gte",
		threshold: 1,
		thresholds_json: TIERS(warningIds, criticalIds),
		window_minutes: 5,
		evaluation_interval_minutes: 1,
		minimum_sample_count: 0,
		consecutive_breaches_required: 1,
		consecutive_healthy_required: 1,
		renotify_interval_minutes: 30,
		destination_ids_json: Arr.dedupe([...warningIds, ...criticalIds]),
		...rest,
	})
}

export const defaultAnomalyRuleRow = (n = 7) => anomalyRuleRow(n)

/** "checkout (production)" on the payments team's scoped rule, routed to the on-call webhook. */
export const scopedAnomalyRuleRow = (n = 8) =>
	anomalyRuleRow(n, {
		name: "Checkout anomalies",
		service_names_json: ["checkout"],
		environments_json: ["production"],
		anomaly_signals_json: ["error_rate", "latency_p95"],
		warningIds: [DESTINATION_ID],
		criticalIds: [DESTINATION_ID],
	})

export type AnomalyIncidentScenario = Readonly<{
	n: number
	ruleN: number
	severity: "warning" | "critical"
	service: string
	environment: string
	status?: "open" | "resolved"
}>

/** The alert incident an anomaly rule opened for an anomaly. */
export const anomalyIncidentRow = (
	scenario: AnomalyIncidentScenario,
	fields: Partial<AlertIncidentRow> = {},
) => {
	const resolved = scenario.status === "resolved"
	return incidentRow({
		id: anomalyAlertIncidentId(scenario.n),
		rule_id: ruleId(scenario.ruleN),
		rule_name: scenario.ruleN === 7 ? "Anomaly detection" : "Checkout anomalies",
		incident_key: `anomaly:${anomalyId(scenario.n)}`,
		group_key: anomalyId(scenario.n),
		group_label: `${scenario.service} (${scenario.environment})`,
		labels_json: { service: scenario.service, environment: scenario.environment },
		anomaly_incident_id: anomalyId(scenario.n),
		signal_type: "anomaly",
		severity: scenario.severity,
		comparator: "gte",
		threshold: 1,
		last_observed_value: resolved ? 0 : scenario.severity === "critical" ? 2 : 1,
		dedupe_key: `anomaly:${anomalyId(scenario.n)}`,
		status: resolved ? "resolved" : "open",
		resolved_at: resolved ? iso(20 * MINUTE) : null,
		first_triggered_at: iso((resolved ? 90 : 42) * MINUTE),
		...fields,
	})
}

type SignalCase = "error_rate" | "latency_p95" | "error_spike"

const SIGNAL_VALUES = {
	error_rate: { opened: 0.061, baseline: 0.004, threshold: 0.02, observed: 0.083, unit: "ratio" },
	latency_p95: { opened: 1620, baseline: 412, threshold: 640, observed: 1840, unit: "milliseconds" },
	error_spike: { opened: 96, baseline: 6, threshold: 30, observed: 148, unit: "count_per_30m" },
} as const

/** The detector's anomaly behind an incident, as `anomalies.getIncident` returns it. */
export const anomalyWire = (
	n: number,
	signal: SignalCase,
	severity: "warning" | "critical",
	service: string,
	environment = "production",
): V2AnomalyIncident => {
	const values = SIGNAL_VALUES[signal]
	const isSpike = signal === "error_spike"
	return Schema.decodeSync(V2AnomalyIncident)({
		id: encodePublicId(PublicIdPrefixes.anomalyIncident, anomalyId(n)),
		object: "anomaly_incident",
		detector_key: `${signal}:${service}:${environment}`,
		signal_type: signal,
		service_name: service,
		deployment_env: environment,
		fingerprint_hash: isSpike ? "fp_7c1e9a40d2b5" : null,
		error_issue_id: isSpike ? encodePublicId(PublicIdPrefixes.errorIssue, ISSUE_ID) : null,
		status: "open",
		severity,
		opened_value: values.opened,
		baseline_median: values.baseline,
		baseline_sigma: values.baseline / 2,
		threshold_value: values.threshold,
		last_observed_value: values.observed,
		last_sample_count: 3100,
		first_triggered_at: iso(42 * MINUTE),
		last_triggered_at: iso(MINUTE),
		resolved_at: null,
		resolve_reason: null,
		triage_status: isSpike ? "pending" : "completed",
		fingerprints: isSpike
			? [
					{
						fingerprint_hash: "fp_7c1e9a40d2b5",
						error_issue_id: encodePublicId(PublicIdPrefixes.errorIssue, ISSUE_ID),
						opened_value: 96,
						last_value: 148,
						severity: "critical",
						attached_at: iso(42 * MINUTE),
						resolved_at: null,
					},
					{
						fingerprint_hash: "fp_02be61f9aa13",
						error_issue_id: null,
						opened_value: 34,
						last_value: 41,
						severity: "warning",
						attached_at: iso(30 * MINUTE),
						resolved_at: null,
					},
				]
			: [],
		reopen_count: 0,
		last_reopened_at: null,
	})
}

/** Two hours of the signal at five-minute buckets: on its baseline, then the jump. */
export const anomalyTimeseriesWire = (signal: SignalCase): V2AnomalyIncidentTimeseries => {
	const values = SIGNAL_VALUES[signal]
	const buckets = Arr.makeBy(24, (index) => {
		const isAnomalous = index >= 16
		const wobble = 1 + 0.12 * Math.sin(index * 1.7)
		return {
			bucket: new Date(NOW - (24 - index) * 5 * MINUTE).toISOString(),
			value: isAnomalous ? values.observed * (0.85 + 0.03 * (index - 16)) : values.baseline * wobble,
			sample_count: 900,
		}
	})
	return Schema.decodeSync(V2AnomalyIncidentTimeseries)({
		object: "anomaly_incident.timeseries",
		signal_type: signal,
		unit: values.unit,
		bucket_seconds: 300,
		buckets,
		baseline_median: values.baseline,
		threshold_value: values.threshold,
	})
}
