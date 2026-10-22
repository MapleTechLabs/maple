import { WorkloadDetailSummaryResponse } from "@maple/domain/http"
import { Schema } from "effect"
import { ChartRuntime } from "../../../../charts/chart-runtime"
import { ThemeColors } from "../../../../charts/theme-colors"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { InfraKubernetesWorkloadParams, InfraKubernetesWorkloadSearch } from "../../../../route/search"
import * as Frame from "../../kit/frame"
import { ChartModels, SeriesSlots } from "../../kit/series"
import { PodsPage } from "../pod-data"

// `/infra/kubernetes/workloads/$kind/$workloadName`.

export const WorkloadSummary = WorkloadDetailSummaryResponse.fields.data
export type WorkloadSummary = WorkloadDetailSummaryResponse["data"]

export const WorkloadKind = InfraKubernetesWorkloadParams.fields.kind
export type WorkloadKind = typeof WorkloadKind.Type

export const WorkloadMetric = Schema.Literals(["cpu_limit", "memory_limit", "cpu_usage"])
export type WorkloadMetric = typeof WorkloadMetric.Type

export const Model = Schema.Struct({
	kind: WorkloadKind,
	workloadName: Schema.String,
	search: InfraKubernetesWorkloadSearch,
	frame: Frame.Model,
	metric: WorkloadMetric,
	/** The "Per-pod breakdown" checkbox (`useState(true)`). */
	groupByPod: Schema.Boolean,
	summary: KeyedSchema(WorkloadSummary, LoadFailure),
	pods: KeyedSchema(PodsPage, LoadFailure),
	/** Series by `metric:groupByPod`. */
	series: SeriesSlots,
	charts: ChartModels,
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
})
export type Model = typeof Model.Type

export const seriesId = (model: Pick<Model, "metric" | "groupByPod">): string => `${model.metric}:${model.groupByPod}`
