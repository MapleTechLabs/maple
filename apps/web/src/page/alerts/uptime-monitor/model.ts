import { UptimeMonitorId } from "@maple/domain"
import { V2UptimeMonitor } from "@maple/domain/http/v2"
import { AlertDestinationRowSchema, AlertIncidentRowSchema } from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import * as Chart from "../../../charts/chart"
import { ChartRuntime } from "../../../charts/chart-runtime"
import { ThemeColors } from "../../../charts/theme-colors"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import * as CopyButton from "../../../ui/copy-button"

// `/alerts/uptime/$monitorId`: one monitor, its recent checks and setup.

/** The response-time chart's window. */
export const UptimeWindow = Schema.Literals(["1h", "24h", "7d"])
export type UptimeWindow = typeof UptimeWindow.Type

/** `ServiceDetailTimeSeriesPoint`, the fields the latency chart and the KPIs read. */
export const CheckPoint = Schema.Struct({
	bucket: Schema.String,
	errorRate: Schema.Number,
	p50LatencyMs: Schema.Number,
	p95LatencyMs: Schema.Number,
	p99LatencyMs: Schema.Number,
	totalCount: Schema.Number,
	partial: Schema.Boolean,
})
export type CheckPoint = typeof CheckPoint.Type

/** `UptimeCheckSample`: one check, from its span. */
export const CheckSample = Schema.Struct({
	at: Schema.String,
	durationMs: Schema.Number,
	ok: Schema.Boolean,
	statusCode: Schema.NullOr(Schema.Number),
	traceId: Schema.String,
})
export type CheckSample = typeof CheckSample.Type
/** `UptimePhaseTimingsPoint`: a bucket's mean phases (ms) over its checks that got a response. */
export const PhasePoint = Schema.Struct({
	bucket: Schema.String,
	timedChecks: Schema.Number,
	dnsMs: Schema.Number,
	connectMs: Schema.Number,
	tlsMs: Schema.Number,
	ttfbMs: Schema.Number,
	transferMs: Schema.Number,
})
export type PhasePoint = typeof PhasePoint.Type

/** `UptimeCheckStats` (@maple/web-data/warehouse/uptime): the window's checks from their spans. */
export const CheckStats = Schema.Struct({
	/** The window these were read for; a switch keeps showing them until the new ones land. */
	window: UptimeWindow,
	points: Schema.Array(CheckPoint),
	samples: Schema.Array(CheckSample),
	samplesTruncated: Schema.Boolean,
	windowStartMs: Schema.Number,
	windowEndMs: Schema.Number,
	checks: Schema.Number,
	failures: Schema.Number,
	p50Ms: Schema.NullOr(Schema.Number),
	p95Ms: Schema.NullOr(Schema.Number),
	p99Ms: Schema.NullOr(Schema.Number),
	phases: Schema.Array(PhasePoint),
})
export type CheckStats = typeof CheckStats.Type

const Rows = <S extends Schema.Top>(row: S) => Schema.NullOr(Schema.Array(row))

export const Model = Schema.Struct({
	/** The URL segment as written; `monitorId` is `null` when it is not a monitor id. */
	rawMonitorId: Schema.String,
	monitorId: Schema.NullOr(UptimeMonitorId),
	nowMs: Schema.NullOr(Schema.Number),
	monitor: KeyedSchema(V2UptimeMonitor, LoadFailure),
	/** Synced destinations (the Setup panel's names) and incidents (the open one, by rule name). */
	destinations: Rows(AlertDestinationRowSchema),
	incidents: Rows(AlertIncidentRowSchema),
	isAdmin: Schema.Boolean,
	isToggling: Schema.Boolean,
	isChecking: Schema.Boolean,
	/** The heartbeat's copy buttons, by snippet id. */
	copies: Schema.Record(Schema.String, CopyButton.Model),
	window: UptimeWindow,
	stats: KeyedSchema(CheckStats, LoadFailure),
	/** The scatter's hovered check, by its index in `samples`. */
	hoveredCheck: Schema.NullOr(Schema.Number),
	chart: Chart.Model,
	phaseChart: Chart.Model,
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
})
export type Model = typeof Model.Type
