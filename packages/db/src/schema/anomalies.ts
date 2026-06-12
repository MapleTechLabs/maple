import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { AnomalyIncidentId, ErrorIssueId, OrgId, UserId } from "@maple/domain/primitives"
import type {
	AnomalyIncidentSeverity,
	AnomalyIncidentStatus,
	AnomalyResolveReason,
	AnomalySensitivity,
	AnomalySignalType,
	AnomalyTriageStatus,
} from "@maple/domain/http"

/**
 * One row per org. Doubles as the org-level claim lock for the anomaly
 * detector tick (CAS on lastTickAt, mirroring alert_rules.lastScheduledAt).
 * The detector is zero-config: a missing row means defaults (enabled).
 */
export const anomalyDetectorSettings = sqliteTable("anomaly_detector_settings", {
	orgId: text("org_id").$type<OrgId>().notNull().primaryKey(),
	enabled: integer("enabled", { mode: "number" }).notNull().default(1),
	sensitivity: text("sensitivity").$type<AnomalySensitivity>().notNull().default("normal"),
	mutedSignalsJson: text("muted_signals_json").notNull().default("[]"),
	lastTickAt: integer("last_tick_at", { mode: "number" }),
	createdAt: integer("created_at", { mode: "number" }).notNull(),
	updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	updatedBy: text("updated_by").$type<UserId>(),
})

/**
 * Hysteresis + cooldown state per detector series (clone of the
 * alert_rule_states mechanics, keyed by detectorKey instead of rule/group).
 * detectorKey = `${signalType}:${deploymentEnv}:${serviceName}` or
 * `error_spike:${deploymentEnv}:${fingerprintHash}`.
 */
export const anomalyDetectorStates = sqliteTable(
	"anomaly_detector_states",
	{
		orgId: text("org_id").$type<OrgId>().notNull(),
		detectorKey: text("detector_key").notNull(),
		signalType: text("signal_type").$type<AnomalySignalType>().notNull(),
		serviceName: text("service_name").notNull(),
		deploymentEnv: text("deployment_env").notNull().default(""),
		fingerprintHash: text("fingerprint_hash"),
		consecutiveBreaches: integer("consecutive_breaches", { mode: "number" }).notNull().default(0),
		consecutiveHealthy: integer("consecutive_healthy", { mode: "number" }).notNull().default(0),
		lastStatus: text("last_status"),
		lastValue: real("last_value"),
		baselineMedian: real("baseline_median"),
		lastSampleCount: integer("last_sample_count", { mode: "number" }),
		lastEvaluatedAt: integer("last_evaluated_at", { mode: "number" }),
		openIncidentId: text("open_incident_id").$type<AnomalyIncidentId>(),
		lastResolvedAt: integer("last_resolved_at", { mode: "number" }),
		/** Most recent incident this series opened or fed — reopen target after a resolve. */
		lastIncidentId: text("last_incident_id").$type<AnomalyIncidentId>(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.orgId, table.detectorKey] }),
		index("anomaly_detector_states_org_idx").on(table.orgId),
		index("anomaly_detector_states_open_incident_idx").on(table.orgId, table.openIncidentId),
		index("anomaly_detector_states_evaluated_idx").on(table.lastEvaluatedAt),
	],
)

/**
 * An anomaly flare-up for one detector series. Self-explaining: carries the
 * observed value, baseline stats, and threshold at open time so the UI and
 * the AI triage prompt can describe the deviation without re-querying.
 */
export const anomalyIncidents = sqliteTable(
	"anomaly_incidents",
	{
		id: text("id").$type<AnomalyIncidentId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		detectorKey: text("detector_key").notNull(),
		signalType: text("signal_type").$type<AnomalySignalType>().notNull(),
		serviceName: text("service_name").notNull(),
		deploymentEnv: text("deployment_env").notNull().default(""),
		fingerprintHash: text("fingerprint_hash"),
		errorIssueId: text("error_issue_id").$type<ErrorIssueId>(),
		status: text("status").$type<AnomalyIncidentStatus>().notNull(),
		severity: text("severity").$type<AnomalyIncidentSeverity>().notNull(),
		openedValue: real("opened_value").notNull(),
		baselineMedian: real("baseline_median").notNull(),
		baselineSigma: real("baseline_sigma").notNull(),
		thresholdValue: real("threshold_value").notNull(),
		lastObservedValue: real("last_observed_value").notNull(),
		lastSampleCount: integer("last_sample_count", { mode: "number" }).notNull().default(0),
		firstTriggeredAt: integer("first_triggered_at", { mode: "number" }).notNull(),
		lastTriggeredAt: integer("last_triggered_at", { mode: "number" }).notNull(),
		resolvedAt: integer("resolved_at", { mode: "number" }),
		resolveReason: text("resolve_reason").$type<AnomalyResolveReason>(),
		triageStatus: text("triage_status").$type<AnomalyTriageStatus>().notNull().default("none"),
		dedupeKey: text("dedupe_key").notNull(),
		/**
		 * Error-spike consolidation: all fingerprints sharing this incident
		 * (JSON array of IncidentFingerprintEntry; empty for golden signals).
		 */
		fingerprintsJson: text("fingerprints_json").notNull().default("[]"),
		/** Times this incident re-breached and reopened within the reopen window. */
		reopenCount: integer("reopen_count", { mode: "number" }).notNull().default(0),
		lastReopenedAt: integer("last_reopened_at", { mode: "number" }),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		index("anomaly_incidents_org_status_idx").on(table.orgId, table.status),
		index("anomaly_incidents_org_triggered_idx").on(table.orgId, table.lastTriggeredAt),
		index("anomaly_incidents_org_detector_idx").on(table.orgId, table.detectorKey),
		index("anomaly_incidents_org_issue_idx").on(table.orgId, table.errorIssueId),
	],
)

export type AnomalyDetectorSettingsRow = typeof anomalyDetectorSettings.$inferSelect
export type AnomalyDetectorStateRow = typeof anomalyDetectorStates.$inferSelect
export type AnomalyDetectorStateInsert = typeof anomalyDetectorStates.$inferInsert
export type AnomalyIncidentRow = typeof anomalyIncidents.$inferSelect
export type AnomalyIncidentInsert = typeof anomalyIncidents.$inferInsert
