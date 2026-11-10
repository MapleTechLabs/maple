// Stored shapes shared by the HTTP contract (`./http/anomalies.ts`) and the Postgres tables.

import { Schema } from "effect"

export const AnomalySignalType = Schema.Literals([
	"error_rate",
	"latency_p95",
	"throughput",
	"error_spike",
	"log_volume",
]).annotate({
	identifier: "@maple/AnomalySignalType",
	title: "Anomaly Signal Type",
})
export type AnomalySignalType = Schema.Schema.Type<typeof AnomalySignalType>

export const AnomalyIncidentStatus = Schema.Literals(["open", "resolved"]).annotate({
	identifier: "@maple/AnomalyIncidentStatus",
	title: "Anomaly Incident Status",
})
export type AnomalyIncidentStatus = Schema.Schema.Type<typeof AnomalyIncidentStatus>

export const AnomalyIncidentSeverity = Schema.Literals(["warning", "critical"]).annotate({
	identifier: "@maple/AnomalyIncidentSeverity",
	title: "Anomaly Incident Severity",
})
export type AnomalyIncidentSeverity = Schema.Schema.Type<typeof AnomalyIncidentSeverity>

export const AnomalyResolveReason = Schema.Literals(["returned_to_baseline", "no_data", "manual"]).annotate({
	identifier: "@maple/AnomalyResolveReason",
	title: "Anomaly Resolve Reason",
})
export type AnomalyResolveReason = Schema.Schema.Type<typeof AnomalyResolveReason>

export const AnomalySensitivity = Schema.Literals(["low", "normal", "high"]).annotate({
	identifier: "@maple/AnomalySensitivity",
	title: "Anomaly Sensitivity",
})
export type AnomalySensitivity = Schema.Schema.Type<typeof AnomalySensitivity>

export const AnomalyTriageStatus = Schema.Literals(["none", "pending", "completed", "skipped"]).annotate({
	identifier: "@maple/AnomalyTriageStatus",
	title: "Anomaly Triage Status",
})
export type AnomalyTriageStatus = Schema.Schema.Type<typeof AnomalyTriageStatus>
