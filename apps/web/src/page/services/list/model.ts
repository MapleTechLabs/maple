import { ChartEnvFields } from "@maple/views/charts/chart-env"
import { V2AnomalyServiceCount } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { ServicesSearch } from "../../../route/search"
import * as FilterSections from "@maple/views/ui/filters/filter-sections"
import * as Tooltip from "@maple/views/ui/tooltip"
import { CommitCardState } from "../../kit/commit-card"
import { SignalPresenceData } from "@maple/views/data/signal-presence"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { IncidentsData } from "../../kit/service-health"

// The `/services` list.

const CommitBreakdown = Schema.Struct({
	commitSha: Schema.String,
	spanCount: Schema.Number,
	percentage: Schema.Number,
	errorCount: Schema.Number,
	firstSeen: Schema.String,
})

/** `ServiceOverview` (`@maple/query-engine` route-rows): one row per service and environment. */
export const ServiceRow = Schema.Struct({
	serviceName: Schema.String,
	serviceNamespace: Schema.String,
	environment: Schema.String,
	commits: Schema.Array(CommitBreakdown),
	p50LatencyMs: Schema.Number,
	p95LatencyMs: Schema.Number,
	p99LatencyMs: Schema.Number,
	errorRate: Schema.Number,
	throughput: Schema.Number,
	tracedThroughput: Schema.Number,
	hasSampling: Schema.Boolean,
	samplingWeight: Schema.Number,
	spanCount: Schema.Number,
})
export type ServiceRow = typeof ServiceRow.Type

/** `getCustomChartServiceSparklines`, reduced to the two series the row draws. */
export const Sparklines = Schema.Record(
	Schema.String,
	Schema.Struct({ throughput: Schema.Array(Schema.Number), errorRate: Schema.Array(Schema.Number) }),
)
export type Sparklines = typeof Sparklines.Type

const FacetCount = Schema.Struct({ name: Schema.String, count: Schema.Number })
export const ServicesFacets = Schema.Struct({
	environments: Schema.Array(FacetCount),
	namespaces: Schema.Array(FacetCount),
	commitShas: Schema.Array(FacetCount),
})
export type ServicesFacets = typeof ServicesFacets.Type

export const LatencyBaseline = Schema.Struct({
	serviceName: Schema.String,
	serviceNamespace: Schema.String,
	environment: Schema.String,
	baselineP95LatencyMs: Schema.Number,
	baselineSpanCount: Schema.Number,
})

export const Model = Schema.Struct({
	search: ServicesSearch,
	/** The resolved window and the clock it was resolved at; `null` until the first resolve. */
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	overview: KeyedSchema(Schema.Array(ServiceRow), LoadFailure),
	sparklines: KeyedSchema(Sparklines, LoadFailure),
	/**
	 * Bumped whenever a memoised `ServiceRow` would re-render (new rows, series, baseline, health or
	 * search): its `PlotFrame` calls `adapter.update` on every render, so the sparklines redraw then.
	 */
	rowRevision: Schema.Number,
	facets: KeyedSchema(ServicesFacets, LoadFailure),
	baseline: KeyedSchema(Schema.Array(LatencyBaseline), LoadFailure),
	anomalies: KeyedSchema(Schema.Array(V2AnomalyServiceCount), LoadFailure),
	/** `useAlertIncidentsList()`: the org's synced incidents. */
	incidents: IncidentsData.schema,
	/** The loaded table has painted; the commit message lookup starts with it. */
	hasPaintedTable: Schema.Boolean,
	/** First lines of the deploy commits on screen, by sha (`commitsQueryAtom`). */
	commitMessages: KeyedSchema(Schema.Record(Schema.String, Schema.String), LoadFailure),
	presence: SignalPresenceData.schema,
	/** The row tooltips: rollout split (left), sampling estimate and `UnnamedServiceHint` (below). */
	rolloutTooltip: Tooltip.Model,
	samplingTooltip: Tooltip.Model,
	unnamedTooltip: Tooltip.Model,
	/** `CommitShaHoverCard` over the deploy cells, and the commits it looked up (`commitQueryAtom`). */
	...CommitCardState.fields,
	filterSections: FilterSections.Model,
	timePicker: TimeRangePicker.Model,
	...ChartEnvFields,
	/** `PageRefreshProvider`: Reloads so far (non-zero stops snapping) and the 600 ms spinner. */
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type
