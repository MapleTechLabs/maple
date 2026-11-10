import { ChartEnvFields } from "@maple/views/charts/chart-env"
import { V2AnomalyServiceCount } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import * as Chart from "@maple/views/charts/chart"
import { FixedMetricRow } from "@maple/views/charts/chart-spec"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { TimeWindow } from "../../data/time-range"
import { HomeSearch } from "../../route/search"
import * as Select from "@maple/views/ui/select"
import { SignalPresenceData } from "@maple/views/data/signal-presence"
import * as TimeRangePicker from "../kit/time-range-picker"
import * as SetupChecklist from "./setup-checklist"
import { IncidentsData } from "../kit/service-health"

/** The facets hint, persisted per org. */
export const FacetsHint = Schema.Struct({
	environment: Schema.NullOr(Schema.String),
	preset: Schema.String,
	seen: Schema.Boolean,
})
export type FacetsHint = typeof FacetsHint.Type

/** The facets the page reads: environment names for the dropdown, service names for the preset. */
export const OverviewFacets = Schema.Struct({
	environments: Schema.Array(Schema.String),
	services: Schema.Array(Schema.String),
})
export type OverviewFacets = typeof OverviewFacets.Type

/** One service's row of `getServiceHealthSnapshot`. */
export const HealthSnapshot = Schema.Struct({
	serviceName: Schema.String,
	environment: Schema.String,
	errorRate: Schema.Number,
	p95LatencyMs: Schema.Number,
	throughput: Schema.Number,
})
export type HealthSnapshot = typeof HealthSnapshot.Type

const UsageTotals = Schema.Struct({
	logs: Schema.Number,
	traces: Schema.Number,
	metrics: Schema.Number,
})
export type UsageTotals = typeof UsageTotals.Type

/** The usage cards' summed totals and the previous window's, when the response carried them. */
export const Usage = Schema.Struct({ totals: UsageTotals, previous: Schema.NullOr(UsageTotals) })
export type Usage = typeof Usage.Type

/** Each alert rule's `enabled`; `Unavailable` when the live rules sync failed or stalled (no banner). */
export const RulesData = AsyncData.Schema(Schema.Array(Schema.Boolean), Schema.Literal("Unavailable"))

/** `ServiceDetailTimeSeriesPoint` (@maple/web-data/warehouse/services): one overview bucket. */
export const OverviewPoint = Schema.Struct({
	bucket: Schema.String,
	throughput: Schema.Number,
	tracedThroughput: Schema.Number,
	hasSampling: Schema.Boolean,
	samplingWeight: Schema.Number,
	errorRate: Schema.Number,
	p50LatencyMs: Schema.Number,
	p95LatencyMs: Schema.Number,
	p99LatencyMs: Schema.Number,
	apdexScore: Schema.Number,
	totalCount: Schema.Number,
	partial: Schema.Boolean,
})
export type OverviewPoint = typeof OverviewPoint.Type

export const RefinementPoint = Schema.Struct({ bucket: Schema.String, throughput: Schema.Number })

export const Model = Schema.Struct({
	search: HomeSearch,
	/** The clock the window was last resolved at; `null` until the entry Command answered. */
	nowMs: Schema.NullOr(Schema.Number),
	/** The stored hint, read with the clock on entry. */
	hint: FacetsHint,
	/** The fixed 24 h facets range, snapped once per mount. */
	facetsWindow: Schema.NullOr(TimeWindow),
	/** The effective window for `search` and the default preset. */
	window: Schema.NullOr(TimeWindow),
	facets: KeyedSchema(OverviewFacets, LoadFailure),
	snapshot: KeyedSchema(Schema.Array(HealthSnapshot), LoadFailure),
	anomalies: KeyedSchema(Schema.Array(V2AnomalyServiceCount), LoadFailure),
	usage: KeyedSchema(Usage, LoadFailure),
	overviewSeries: KeyedSchema(Schema.Array(OverviewPoint), LoadFailure),
	logSeries: KeyedSchema(Schema.Array(FixedMetricRow), LoadFailure),
	refinement: KeyedSchema(Schema.Array(RefinementPoint), LoadFailure),
	incidents: IncidentsData.schema,
	rules: RulesData.schema,
	/** Signal presence for the services empty state, sent once it painted. */
	presence: SignalPresenceData.schema,
	environmentSelect: Select.Model,
	timePicker: TimeRangePicker.Model,
	/** One chart Submodel per card (hover, tooltip), by card id. */
	charts: Schema.Record(Schema.String, Chart.Model),
	...ChartEnvFields,
	/** Reloads so far (non-zero stops snapping) and the 600 ms spinner. */
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
	/** `SetupChecklist`, Clerk mode only (`null` self-hosted). */
	setup: Schema.NullOr(SetupChecklist.Model),
})
export type Model = typeof Model.Type
