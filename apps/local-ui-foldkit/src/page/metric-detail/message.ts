import * as Chart from "@maple/web-foldkit/charts/chart"
import { ThemeColors } from "@maple/web-foldkit/charts/theme-colors"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../data/local-query"
import { MetricEntry } from "../metrics/catalog"
import { BreakdownRow, SeriesPoint } from "./fetch"

export const Message = defineMessageUnion({
	CompletedReadClock: { nowMs: Schema.Number },
	SucceededFetchEntry: { key: Schema.String, entry: Schema.NullOr(MetricEntry), fetchedAtMs: Schema.Number },
	FailedFetchEntry: { key: Schema.String, failure: LoadFailure },
	SucceededFetchTimeseries: { key: Schema.String, points: Schema.Array(SeriesPoint) },
	FailedFetchTimeseries: { key: Schema.String, failure: LoadFailure },
	SucceededFetchBreakdown: { key: Schema.String, rows: Schema.Array(BreakdownRow) },
	FailedFetchBreakdown: { key: Schema.String, failure: LoadFailure },
	ClickedBack: {},
	ClickedRefresh: {},
	CompletedReadRefreshClock: { nowMs: Schema.Number },
	ChangedRange: { range: Schema.String },
	ClickedWidenRange: {},
	ResolvedThemeColors: { colors: ThemeColors },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	GotChartMessage: { message: Chart.Message },
})
export type Message = typeof Message.Type
