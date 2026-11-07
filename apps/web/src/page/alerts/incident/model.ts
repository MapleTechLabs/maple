import { AlertDeliveryEventDocument } from "@maple/domain/http"
import {
	V2AlertIncidentEscalation,
	V2AlertIncidentEvent,
	V2AlertSilence,
	V2AnomalyIncident,
	V2AnomalyIncidentTimeseries,
	V2Investigation,
	V2Slo,
	V2UptimeMonitor,
} from "@maple/domain/http/v2"
import {
	AlertIncidentRowSchema,
	AlertRuleRowSchema,
	AlertRuleStateRowSchema,
} from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import * as Policy from "@maple/domain/policy"
import * as Chart from "@maple/views/charts/chart"
import { ChartRuntime } from "@maple/views/charts/chart-runtime"
import { ThemeColors } from "@maple/views/charts/theme-colors"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { CheckSummary } from "../shared/check-summary"
import { PreviewSlot } from "../shared/preview"
import * as SilenceDialog from "../silence-dialog/dialog"

// `/alerts/incidents/$incidentId`.

const Rows = <S extends Schema.Top>(row: S) => Schema.NullOr(Schema.Array(row))

export const Model = Schema.Struct({
	incidentId: Schema.String,
	/** `clockAtSync`: the wall clock to the minute, read when the incident first arrives. */
	nowMs: Schema.NullOr(Schema.Number),
	incidents: Rows(AlertIncidentRowSchema),
	rules: Rows(AlertRuleRowSchema),
	states: Rows(AlertRuleStateRowSchema),
	preview: PreviewSlot,
	/** What the evaluator recorded over the range: the chart's line when the query cannot be replayed. */
	checks: KeyedSchema(CheckSummary, LoadFailure),
	deliveries: KeyedSchema(Schema.Array(AlertDeliveryEventDocument), LoadFailure),
	investigation: KeyedSchema(Schema.NullOr(V2Investigation), LoadFailure),
	/** The incident's latest escalation run (`alertIncidents.retrieve`), re-read as the incident changes. */
	escalation: KeyedSchema(Schema.NullOr(V2AlertIncidentEscalation), LoadFailure),
	/** Acknowledgement history, refetched whenever the incident's acknowledgement changes. */
	activity: KeyedSchema(Schema.Array(V2AlertIncidentEvent), LoadFailure),
	/** An acknowledge or unacknowledge request is running. */
	isUpdatingAcknowledgement: Schema.Boolean,
	/** An SLO incident's link to its SLO: `slos.list`, read only for one. */
	slos: KeyedSchema(Schema.Array(V2Slo), LoadFailure),
	/** An uptime incident's link to its monitor: `uptimeMonitors.list`, read only for one. */
	monitors: KeyedSchema(Schema.Array(V2UptimeMonitor), LoadFailure),
	/** An anomaly rule's incident: the detector's anomaly and its signal, read only for one. */
	anomaly: KeyedSchema(V2AnomalyIncident, LoadFailure),
	anomalyTimeseries: KeyedSchema(V2AnomalyIncidentTimeseries, LoadFailure),
	anomalyChart: Chart.Model,
	/** `useAsyncAction`: the create request is running, so repeat clicks cannot start duplicates. */
	isStartingInvestigation: Schema.Boolean,
	chart: Chart.Model,
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
	/** `alertSilences.list`: which silence, if any, holds back this incident's notifications. */
	silences: KeyedSchema(Schema.Array(V2AlertSilence), LoadFailure),
	silenceDialog: SilenceDialog.Model,
	/** What the session may do (`Policy.grantsOf`); none until it answers, so Silence stays hidden. */
	grants: Schema.Array(Policy.PermissionName),
	/** The clock as read, not floored: a silence created this minute is already in force. */
	clockMs: Schema.NullOr(Schema.Number),
})
export type Model = typeof Model.Type
