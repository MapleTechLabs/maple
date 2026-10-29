import { ThemeColors } from "@maple/web/charts/theme-colors"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { CachedOf } from "../../data/cached"
import { LoadFailure } from "../../data/local-query"
import { BreakdownRequest, EntryRequest, TimeseriesRequest } from "./requests"
import { MetricEntry } from "../metrics/catalog"
import { BreakdownRow, SeriesPoint } from "./fetch"

export const Message = defineMessageUnion({
	CompletedReadClock: { nowMs: Schema.Number },
	SucceededFetchEntry: { key: Schema.String, entry: Schema.NullOr(MetricEntry), fetchedAtMs: Schema.Number },
	FailedFetchEntry: { key: Schema.String, failure: LoadFailure },
	/** The result cache answered first; `request` is the read the fetch then repeats. */
	FoundCachedEntry: { request: EntryRequest, cached: CachedOf(Schema.NullOr(MetricEntry)) },
	SucceededFetchTimeseries: { key: Schema.String, points: Schema.Array(SeriesPoint), fetchedAtMs: Schema.Number },
	FailedFetchTimeseries: { key: Schema.String, failure: LoadFailure },
	FoundCachedTimeseries: { request: TimeseriesRequest, cached: CachedOf(Schema.Array(SeriesPoint)) },
	SucceededFetchBreakdown: { key: Schema.String, rows: Schema.Array(BreakdownRow), fetchedAtMs: Schema.Number },
	FailedFetchBreakdown: { key: Schema.String, failure: LoadFailure },
	FoundCachedBreakdown: { request: BreakdownRequest, cached: CachedOf(Schema.Array(BreakdownRow)) },
	ClickedBack: {},
	ClickedRefresh: {},
	CompletedReadRefreshClock: { nowMs: Schema.Number },
	ChangedRange: { range: Schema.String },
	ClickedWidenRange: {},
	ResolvedThemeColors: { colors: ThemeColors },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	/** The root saw the fragment change under the open page: the range reloads. */
	InformedOfLocationChange: {},
})
export type Message = typeof Message.Type
