import { ChartEnvFields } from "@maple/views/charts/chart-env"
import { ContainerDetailSummaryResponse } from "@maple/domain/http"
import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { InfraContainerSearch } from "../../../../route/search"
import * as Frame from "../../../kit/time-frame"
import { ChartModels, SeriesSlots } from "../../../kit/series"

// `/infra/containers/$containerName`.

export const ContainerSummary = ContainerDetailSummaryResponse.fields.data
export type ContainerSummary = ContainerDetailSummaryResponse["data"]

export const ContainerMetric = Schema.Literals([
	"cpu",
	"memory_percent",
	"memory_bytes",
	"network",
	"disk_io",
])
export type ContainerMetric = typeof ContainerMetric.Type

export const Model = Schema.Struct({
	containerName: Schema.String,
	search: InfraContainerSearch,
	frame: Frame.Model,
	/** The metric tab (`useState("cpu")`). */
	metric: ContainerMetric,
	summary: KeyedSchema(ContainerSummary, LoadFailure),
	series: SeriesSlots,
	charts: ChartModels,
	...ChartEnvFields,
})
export type Model = typeof Model.Type
