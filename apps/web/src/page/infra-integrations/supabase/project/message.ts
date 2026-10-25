import {
	SupabaseApiTopPathsResponse,
	SupabaseApiTrafficResponse,
	SupabaseLogIssuesResponse,
	SupabaseProjectCallersResponse,
	SupabaseProjectInsights,
} from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../../charts/chart"
import { ThemeColors } from "../../../../charts/theme-colors"
import { LoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { SupabaseProjectRow, SupabaseProjectTimeseriesRow, SupabaseStatus } from "../model"
import { Section } from "./model"

export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

const completed = <A, AI>(schema: Schema.Codec<A, AI>) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedLoadStatus: completed(SupabaseStatus),
	CompletedFetchProjects: completed(Schema.Array(SupabaseProjectRow)),
	CompletedFetchTimeseries: completed(Schema.Array(SupabaseProjectTimeseriesRow)),
	CompletedFetchTraffic: completed(SupabaseApiTrafficResponse),
	CompletedFetchTopPaths: completed(SupabaseApiTopPathsResponse),
	CompletedFetchCallers: completed(SupabaseProjectCallersResponse),
	CompletedFetchIssues: completed(SupabaseLogIssuesResponse),
	CompletedFetchInsights: completed(SupabaseProjectInsights),
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	ClickedRetry: { section: Section },
	ClickedToggleTopPaths: {},
	ClickedReload: {},
	ClickedResetTimeRange: {},
	CompletedReloadSpin: { version: Schema.Number },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotChartMessage: { chartId: Schema.String, message: Chart.Message },
})
export type Message = typeof Message.Type
