import { ChartRuntime } from "@maple/web/charts/chart-runtime"
import { ThemeColors } from "@maple/web/charts/theme-colors"
import * as Chart from "@maple/web/charts/chart"
import * as FilterSections from "@maple/web/ui/filters/filter-sections"
import { Schema } from "effect"
import { SlotSchema } from "../../data/slot"
import { Copies } from "../kit/copies"
import { MetricsListData } from "./catalog"
import { GridViewport } from "./derive"
import { MetricSparkline, SummaryRow } from "./fetch"

/** A debounced text input: what is typed, a version that retires timers, and the last sent value. */
export const Draft = Schema.Struct({ text: Schema.String, version: Schema.Number, sent: Schema.String })
export type Draft = typeof Draft.Type

export const Model = Schema.TaggedStruct("MetricsPage", {
	/** `useTimeWindow`'s anchor, snapped to the minute; none until the clock is read. */
	maybeAnchorMs: Schema.Option(Schema.Number),
	/** The clock at the last read: `chartWindow`'s "now". */
	nowMs: Schema.Number,
	list: SlotSchema(MetricsListData),
	/** `dataUpdatedAt` of the list, for the "New data" pill. */
	listUpdatedAtMs: Schema.Number,
	summary: SlotSchema(Schema.Array(SummaryRow)),
	sparklines: SlotSchema(Schema.Array(MetricSparkline)),
	search: Draft,
	sections: FilterSections.Model,
	isRefreshing: Schema.Boolean,
	/** The grid's scroller: width picks the columns, height and offset the drawn rows; 0 before measured. */
	grid: GridViewport,
	themeColors: Schema.NullOr(ThemeColors),
	chartRuntime: ChartRuntime,
	/** Sparklines keep no interaction state; every card embeds this one chart Model. */
	sparkline: Chart.Model,
	copies: Copies,
})
export type Model = typeof Model.Type
