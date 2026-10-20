import { Schema } from "effect"
import { ChartRuntime } from "../../../../charts/chart-runtime"
import { ThemeColors } from "../../../../charts/theme-colors"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { InfraKubernetesPodSearch } from "../../../../route/search"
import * as Frame from "../../kit/frame"
import { ChartModels, SeriesSlots } from "../../kit/series"
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
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
})
export type Model = typeof Model.Type
