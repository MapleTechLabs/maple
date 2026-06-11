import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { AnomalyIncidentId, ErrorIssueId, IsoDateTimeString, UserId } from "../primitives"
import { Authorization } from "./current-tenant"

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

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

export const AnomalyResolveReason = Schema.Literals([
	"returned_to_baseline",
	"no_data",
	"manual",
]).annotate({
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

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export class AnomalyIncidentDocument extends Schema.Class<AnomalyIncidentDocument>(
	"AnomalyIncidentDocument",
)({
	id: AnomalyIncidentId,
	detectorKey: Schema.String,
	signalType: AnomalySignalType,
	serviceName: Schema.String,
	deploymentEnv: Schema.String,
	fingerprintHash: Schema.NullOr(Schema.String),
	errorIssueId: Schema.NullOr(ErrorIssueId),
	status: AnomalyIncidentStatus,
	severity: AnomalyIncidentSeverity,
	openedValue: Schema.Number,
	baselineMedian: Schema.Number,
	baselineSigma: Schema.Number,
	thresholdValue: Schema.Number,
	lastObservedValue: Schema.Number,
	lastSampleCount: Schema.Number,
	firstTriggeredAt: IsoDateTimeString,
	lastTriggeredAt: IsoDateTimeString,
	resolvedAt: Schema.NullOr(IsoDateTimeString),
	resolveReason: Schema.NullOr(AnomalyResolveReason),
	triageStatus: AnomalyTriageStatus,
}) {}

export class AnomalyIncidentsListResponse extends Schema.Class<AnomalyIncidentsListResponse>(
	"AnomalyIncidentsListResponse",
)({
	incidents: Schema.Array(AnomalyIncidentDocument),
}) {}

export class AnomalyDetectorSettingsDocument extends Schema.Class<AnomalyDetectorSettingsDocument>(
	"AnomalyDetectorSettingsDocument",
)({
	enabled: Schema.Boolean,
	sensitivity: AnomalySensitivity,
	mutedSignals: Schema.Array(AnomalySignalType),
	updatedAt: Schema.NullOr(IsoDateTimeString),
	updatedBy: Schema.NullOr(UserId),
}) {}

export class AnomalyDetectorSettingsUpdateRequest extends Schema.Class<AnomalyDetectorSettingsUpdateRequest>(
	"AnomalyDetectorSettingsUpdateRequest",
)({
	enabled: Schema.optionalKey(Schema.Boolean),
	sensitivity: Schema.optionalKey(AnomalySensitivity),
	mutedSignals: Schema.optionalKey(Schema.Array(AnomalySignalType)),
}) {}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AnomalyPersistenceError extends Schema.TaggedErrorClass<AnomalyPersistenceError>()(
	"@maple/http/anomalies/AnomalyPersistenceError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.String),
	},
	{ httpApiStatus: 503 },
) {}

export class AnomalyForbiddenError extends Schema.TaggedErrorClass<AnomalyForbiddenError>()(
	"@maple/http/anomalies/AnomalyForbiddenError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 403 },
) {}

export class AnomalyIncidentNotFoundError extends Schema.TaggedErrorClass<AnomalyIncidentNotFoundError>()(
	"@maple/http/anomalies/AnomalyIncidentNotFoundError",
	{
		message: Schema.String,
		incidentId: AnomalyIncidentId,
	},
	{ httpApiStatus: 404 },
) {}

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

const IncidentListQuery = Schema.Struct({
	status: Schema.optional(AnomalyIncidentStatus),
	signalType: Schema.optional(AnomalySignalType),
	service: Schema.optional(Schema.String),
	deploymentEnv: Schema.optional(Schema.String),
	startTime: Schema.optional(IsoDateTimeString),
	endTime: Schema.optional(IsoDateTimeString),
	limit: Schema.optional(
		Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 500 })),
	),
})

// ---------------------------------------------------------------------------
// API group
// ---------------------------------------------------------------------------

export class AnomaliesApiGroup extends HttpApiGroup.make("anomalies")
	.add(
		HttpApiEndpoint.get("listIncidents", "/incidents", {
			query: IncidentListQuery,
			success: AnomalyIncidentsListResponse,
			error: AnomalyPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.get("getIncident", "/incidents/:incidentId", {
			params: { incidentId: AnomalyIncidentId },
			success: AnomalyIncidentDocument,
			error: [AnomalyPersistenceError, AnomalyIncidentNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.get("getSettings", "/settings", {
			success: AnomalyDetectorSettingsDocument,
			error: AnomalyPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.put("updateSettings", "/settings", {
			payload: AnomalyDetectorSettingsUpdateRequest,
			success: AnomalyDetectorSettingsDocument,
			error: [AnomalyPersistenceError, AnomalyForbiddenError],
		}),
	)
	.prefix("/api/anomalies")
	.middleware(Authorization) {}
