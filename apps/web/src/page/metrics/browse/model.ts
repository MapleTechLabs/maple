import { ChartEnvFields } from "@maple/views/charts/chart-env"
import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { MetricsSearch } from "../../../route/search"
import * as Select from "@maple/views/ui/select"
import { SignalPresenceData } from "@maple/views/data/signal-presence"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { MetricRow } from "../shared"

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
	/** The grid's catalog (limit 500), unique metrics paged client-side. */
	catalog: KeyedSchema(Catalog, LoadFailure),
	/** Grid pages mounted so far. */
	visiblePages: Schema.Number,
	/** `getMetricSparklines` answers by request key (one query per grid page and metric type). */
	sparklines: Schema.Record(Schema.String, SparklineSlot),
	/** The table's list and its `limit` (Load more adds a page). */
	table: KeyedSchema(Catalog, LoadFailure),
	tableLimit: Schema.Number,
	/** The type filter's counts. */
	summary: KeyedSchema(Schema.Array(SummaryRow), LoadFailure),
	/** The toolbar search: what is typed, and the debounce run that may still commit it. */
	searchInput: Schema.String,
	searchGeneration: Schema.Number,
	/** The trimmed query this input last committed, to tell its own echo from an outside change. */
	lastSentQuery: Schema.String,
	typeSelect: Select.Model,
	presence: SignalPresenceData.schema,
	timePicker: TimeRangePicker.Model,
	...ChartEnvFields,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type
