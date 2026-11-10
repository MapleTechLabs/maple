import { ChartEnvFields } from "@maple/views/charts/chart-env"
import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { InfraKubernetesPodSearch } from "../../../../route/search"
import * as Frame from "../../../kit/time-frame"
import { ChartModels, SeriesSlots } from "../../../kit/series"
import { PodMetric, PodSummary, RestartRows } from "../pod-data"

// `/infra/kubernetes/pods/$podName`.

export const Model = Schema.Struct({
	podName: Schema.String,
	search: InfraKubernetesPodSearch,
	frame: Frame.Model,
	metric: PodMetric,
	summary: KeyedSchema(PodSummary, LoadFailure),
	/** `podRestartsAtom` for this pod: the Restarts tile and the per-container table share it. */
	restarts: KeyedSchema(RestartRows, LoadFailure),
	series: SeriesSlots,
	charts: ChartModels,
	...ChartEnvFields,
})
export type Model = typeof Model.Type
