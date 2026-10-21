import {
	SupabaseApiTopPathsResponse,
	SupabaseApiTrafficResponse,
	SupabaseLogIssuesResponse,
	SupabaseProjectCallersResponse,
	SupabaseProjectInsights,
} from "@maple/domain/http"
import { Schema } from "effect"
import * as Chart from "../../../../charts/chart"
import { ChartRuntime } from "../../../../charts/chart-runtime"
import { ThemeColors } from "../../../../charts/theme-colors"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { InfraSupabaseProjectSearch } from "../../../../route/search"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { SupabaseProjectRow, SupabaseProjectTimeseriesRow, SupabaseStatus } from "../model"

// `/infra/supabase/$projectRef`.

const keyed = <A, AI>(schema: Schema.Codec<A, AI>) => KeyedSchema(schema, LoadFailure)

/** The page's independently retried reads. */
export const Section = Schema.Literals(["timeseries", "traffic", "topPaths", "callers", "issues", "insights"])
export type Section = typeof Section.Type

export const Model = Schema.Struct({
	projectRef: Schema.String,
	search: InfraSupabaseProjectSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	status: keyed(SupabaseStatus),
	projects: keyed(Schema.Array(SupabaseProjectRow)),
	timeseries: keyed(Schema.Array(SupabaseProjectTimeseriesRow)),
	traffic: keyed(SupabaseApiTrafficResponse),
	topPaths: keyed(SupabaseApiTopPathsResponse),
	callers: keyed(SupabaseProjectCallersResponse),
	issues: keyed(SupabaseLogIssuesResponse),
	insights: keyed(SupabaseProjectInsights),
	isTopPathsOpen: Schema.Boolean,
	charts: Schema.Record(Schema.String, Chart.Model),
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
	timePicker: TimeRangePicker.Model,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type
