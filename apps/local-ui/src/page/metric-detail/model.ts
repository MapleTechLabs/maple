import * as Chart from "@maple/views/charts/chart"
import { ChartRuntime } from "@maple/views/charts/chart-runtime"
import { ThemeColors } from "@maple/views/charts/theme-colors"
import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { MetricEntry } from "../metrics/catalog"
import { BreakdownRow, SeriesPoint } from "./fetch"

export const Model = Schema.TaggedStruct("MetricDetailPage", {
	metricName: Schema.String,
	/** `useTimeWindow`'s anchor, snapped to the minute; none until the clock is read. */
	maybeAnchorMs: Schema.Option(Schema.Number),
	/** The clock at the last read: `chartWindow`'s "now" and relative times. */
	nowMs: Schema.Number,
	entry: KeyedSchema(Schema.NullOr(MetricEntry), LoadFailure),
	entryUpdatedAtMs: Schema.Number,
	timeseries: KeyedSchema(Schema.Array(SeriesPoint), LoadFailure),
	breakdown: KeyedSchema(Schema.Array(BreakdownRow), LoadFailure),
	isRefreshing: Schema.Boolean,
	chart: Chart.Model,
	themeColors: Schema.NullOr(ThemeColors),
	chartRuntime: ChartRuntime,
})
export type Model = typeof Model.Type
