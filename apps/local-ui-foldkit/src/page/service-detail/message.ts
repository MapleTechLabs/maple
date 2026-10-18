import * as Chart from "@maple/web-foldkit/charts/chart"
import { ThemeColors } from "@maple/web-foldkit/charts/theme-colors"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../data/local-query"
import { GoldenSignalRow, OperationRow, Overview, SeriesPoint } from "./model"

export const Message = defineMessageUnion({
	CompletedReadClock: { nowMs: Schema.Number },
	SucceededFetchOverview: { key: Schema.String, overview: Overview, fetchedAtMs: Schema.Number },
	FailedFetchOverview: { key: Schema.String, failure: LoadFailure },
	SucceededFetchOperations: { key: Schema.String, operations: Schema.Array(OperationRow) },
	FailedFetchOperations: { key: Schema.String, failure: LoadFailure },
	SucceededFetchTimeseries: { key: Schema.String, points: Schema.Array(SeriesPoint) },
	FailedFetchTimeseries: { key: Schema.String, failure: LoadFailure },
	SucceededFetchGoldenSignals: { key: Schema.String, rows: Schema.Array(GoldenSignalRow) },
	FailedFetchGoldenSignals: { key: Schema.String, failure: LoadFailure },
	ClickedRetryOverview: {},
	ClickedRetryOperations: {},
	ClickedRetryGoldenSignals: {},
	ClickedRefresh: {},
	CompletedReadRefreshClock: { nowMs: Schema.Number },
	ClickedBack: {},
	ChangedRange: { range: Schema.String },
	ClickedWidenRange: {},
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	GotChartMessage: { chartId: Schema.String, message: Chart.Message },
})
export type Message = typeof Message.Type
