import { ChartEnvFields } from "@maple/views/charts/chart-env"
import { NodeDetailSummaryResponse } from "@maple/domain/http"
import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { InfraKubernetesNodeSearch } from "../../../../route/search"
import * as Frame from "../../kit/frame"
import { ChartModels, SeriesSlots } from "../../../kit/series"
import { PodsPage } from "../pod-data"

// `/infra/kubernetes/nodes/$nodeName`.

export const NodeSummary = NodeDetailSummaryResponse.fields.data
export type NodeSummary = NodeDetailSummaryResponse["data"]

export const NodeMetric = Schema.Literals([
	"cpu_usage",
	"cpu_utilization",
	"memory_usage",
	"memory_utilization",
	"uptime",
])
export type NodeMetric = typeof NodeMetric.Type

export const Model = Schema.Struct({
	nodeName: Schema.String,
	search: InfraKubernetesNodeSearch,
	frame: Frame.Model,
	metric: NodeMetric,
	summary: KeyedSchema(NodeSummary, LoadFailure),
	/** Pods on this node: `listPods` with `nodeNames: [nodeName]`, limit 200. */
	pods: KeyedSchema(PodsPage, LoadFailure),
	series: SeriesSlots,
	charts: ChartModels,
	...ChartEnvFields,
})
export type Model = typeof Model.Type
