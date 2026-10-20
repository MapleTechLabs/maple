import { Schema } from "effect"
import { ChartRuntime } from "../../../charts/chart-runtime"
import { ThemeColors } from "../../../charts/theme-colors"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { MetricsSearch } from "../../../route/search"
import * as Select from "../../../ui/select"
import { SignalPresenceData } from "../../kit/signal-presence"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { MetricRow } from "../shared"

// `/metrics`.

export const SparklinePoint = Schema.Struct({
	bucket: Schema.String,
	avgValue: Schema.Number,
	sumValue: Schema.Number,
	dataPointCount: Schema.Number,
})
export type SparklinePoint = typeof SparklinePoint.Type

/** `getMetricSparklines` for one metric type: points by metric name. */
export const SparklineSeries = Schema.Array(
	Schema.Struct({ metricName: Schema.String, points: Schema.Array(SparklinePoint) }),
)
export type SparklineSeries = typeof SparklineSeries.Type

export const SummaryRow = Schema.Struct({
	metricType: Schema.String,
	metricCount: Schema.Number,
	dataPointCount: Schema.Number,
})
export type SummaryRow = typeof SummaryRow.Type

export const Catalog = Schema.Array(MetricRow)
export const SparklineSlot = KeyedSchema(SparklineSeries, LoadFailure)

export const Model = Schema.Struct({
	search: MetricsSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	/** `MetricPreviewGrid`'s catalog (limit 500), unique metrics paged client-side. */
	catalog: KeyedSchema(Catalog, LoadFailure),
	/** `GridPage`s mounted so far (`visiblePages`). */
	visiblePages: Schema.Number,
	/** `getMetricSparklines` answers by request key (one query per grid page and metric type). */
	sparklines: Schema.Record(Schema.String, SparklineSlot),
	/** `MetricsTable`'s list and its `limit` (Load more adds a page). */
	table: KeyedSchema(Catalog, LoadFailure),
	tableLimit: Schema.Number,
	/** `MetricsTypeFilter`'s counts. */
	summary: KeyedSchema(Schema.Array(SummaryRow), LoadFailure),
	/** `ToolbarSearch`: what is typed, and the debounce run that may still commit it. */
	searchInput: Schema.String,
	searchGeneration: Schema.Number,
	/** The trimmed query this input last committed, to tell its own echo from an outside change. */
	lastSentQuery: Schema.String,
	typeSelect: Select.Model,
	presence: SignalPresenceData.schema,
	timePicker: TimeRangePicker.Model,
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type
