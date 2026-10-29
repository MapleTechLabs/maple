import { ThemeColors } from "@maple/web/charts/theme-colors"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { CachedOf } from "../../data/cached"
import { LoadFailure } from "../../data/local-query"
import { GoldenSignalRow, OperationRow, Overview, SeriesPoint } from "./model"

export const Message = defineMessageUnion({
	CompletedReadClock: { nowMs: Schema.Number },
	SucceededFetchOverview: { key: Schema.String, overview: Overview, fetchedAtMs: Schema.Number },
	FailedFetchOverview: { key: Schema.String, failure: LoadFailure },
	/** The result cache answered a slot (or an older window of it) before the fetch ran. */
	FoundCachedOverview: { key: Schema.String, cached: CachedOf(Overview) },
	SucceededFetchOperations: {
		key: Schema.String,
		operations: Schema.Array(OperationRow),
		fetchedAtMs: Schema.Number,
	},
	FailedFetchOperations: { key: Schema.String, failure: LoadFailure },
	FoundCachedOperations: { key: Schema.String, cached: CachedOf(Schema.Array(OperationRow)) },
	SucceededFetchTimeseries: {
		key: Schema.String,
		points: Schema.Array(SeriesPoint),
		fetchedAtMs: Schema.Number,
	},
	FailedFetchTimeseries: { key: Schema.String, failure: LoadFailure },
	FoundCachedTimeseries: { key: Schema.String, cached: CachedOf(Schema.Array(SeriesPoint)) },
	SucceededFetchGoldenSignals: {
		key: Schema.String,
		rows: Schema.Array(GoldenSignalRow),
		fetchedAtMs: Schema.Number,
	},
	FailedFetchGoldenSignals: { key: Schema.String, failure: LoadFailure },
	FoundCachedGoldenSignals: { key: Schema.String, cached: CachedOf(Schema.Array(GoldenSignalRow)) },
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
	InformedOfLocationChange: {},
})
export type Message = typeof Message.Type
