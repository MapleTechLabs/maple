import { ChartEnvFields } from "@maple/views/charts/chart-env"
import { HostDetailSummaryResponse } from "@maple/domain/http"
import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { InfraHostSearch } from "../../../../route/search"
import * as Frame from "../../../kit/time-frame"
import { Copies } from "../../kit/resource-attributes"
import { ChartModels, SeriesSlots } from "../../../kit/series"

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
	...ChartEnvFields,
	copies: Copies,
})
export type Model = typeof Model.Type
