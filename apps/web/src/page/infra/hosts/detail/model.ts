import { HostDetailSummaryResponse } from "@maple/domain/http"
import { Schema } from "effect"
import { ChartRuntime } from "../../../../charts/chart-runtime"
import { ThemeColors } from "../../../../charts/theme-colors"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { InfraHostSearch } from "../../../../route/search"
import * as Frame from "../../kit/frame"
import { Copies } from "../../kit/resource-attributes"
import { ChartModels, SeriesSlots } from "../../kit/series"

// `/infra/hosts/$hostName`.

export const HostSummary = HostDetailSummaryResponse.fields.data
export type HostSummary = HostDetailSummaryResponse["data"]

export const Model = Schema.Struct({
	hostName: Schema.String,
	search: InfraHostSearch,
	frame: Frame.Model,
	summary: KeyedSchema(HostSummary, LoadFailure),
	/** One `hostInfraTimeseries` slot per metric strip. */
	series: SeriesSlots,
	charts: ChartModels,
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
	copies: Copies,
})
export type Model = typeof Model.Type
