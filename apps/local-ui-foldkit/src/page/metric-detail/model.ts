import * as Chart from "@maple/web/charts/chart"
import { ChartRuntime } from "@maple/web/charts/chart-runtime"
import { ThemeColors } from "@maple/web/charts/theme-colors"
import { Schema } from "effect"
import { SlotSchema } from "../../data/slot"
import { MetricEntry } from "../metrics/catalog"
import { BreakdownRow, SeriesPoint } from "./fetch"

export const Model = Schema.TaggedStruct("MetricDetailPage", {
	metricName: Schema.String,
	/** `useTimeWindow`'s anchor, snapped to the minute; none until the clock is read. */
	maybeAnchorMs: Schema.Option(Schema.Number),
	/** The clock at the last read: `chartWindow`'s "now" and relative times. */
	nowMs: Schema.Number,
	entry: SlotSchema(Schema.NullOr(MetricEntry)),
	entryUpdatedAtMs: Schema.Number,
	timeseries: SlotSchema(Schema.Array(SeriesPoint)),
	breakdown: SlotSchema(Schema.Array(BreakdownRow)),
	isRefreshing: Schema.Boolean,
	chart: Chart.Model,
	themeColors: Schema.NullOr(ThemeColors),
	chartRuntime: ChartRuntime,
})
export type Model = typeof Model.Type
