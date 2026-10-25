import { ListPodsResponse, PodDetailSummaryResponse, PodRestartsResponse } from "@maple/domain/http"
import {
	listPods,
	podDetailSummary,
	podInfraTimeseries,
	podRestarts,
	type ListPodsInput,
	type PodRestartsInput,
} from "@maple/web-data/warehouse/infra"
import { Effect, Schema } from "effect"
import { toLoadFailure } from "../../../data/load-failure"

// The pod list and its restarts as every Kubernetes page reads them (`listPodsResultAtom`,
// `podRestartsResultAtom`). Pages wrap these Effects in their own Commands.

export const PodsPage = Schema.Struct(ListPodsResponse.fields)
export type PodsPage = typeof PodsPage.Type
export type PodRow = PodsPage["data"][number]

export const RestartRows = PodRestartsResponse.fields.data
export type RestartRow = PodRestartsResponse["data"][number]

const StringList = Schema.optional(Schema.Array(Schema.String))

/** `ListPodsInput` as data, so it rides in a Command's args. */
export const PodsInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	search: Schema.optional(Schema.String),
	podNames: StringList,
	namespaces: StringList,
	nodeNames: StringList,
	clusters: StringList,
	deployments: StringList,
	statefulsets: StringList,
	daemonsets: StringList,
	jobs: StringList,
	environments: StringList,
	computeTypes: StringList,
	excludedPodNames: StringList,
	excludedNamespaces: StringList,
	excludedNodeNames: StringList,
	excludedClusters: StringList,
	excludedDeployments: StringList,
	excludedStatefulsets: StringList,
	excludedDaemonsets: StringList,
	excludedJobs: StringList,
	excludedEnvironments: StringList,
	excludedComputeTypes: StringList,
	workloadKind: Schema.optional(Schema.Literals(["deployment", "statefulset", "daemonset", "job"])),
	workloadName: Schema.optional(Schema.String),
	scope: Schema.optional(Schema.Literals(["saturated", "elevated", "unbounded"])),
	lifecycle: Schema.optional(Schema.Literals(["live", "ended", "all"])),
	sortBy: Schema.optional(
		Schema.Literals(["saturation", "cpuUsage", "cpuLimitPct", "memoryLimitPct", "podName", "lastSeen"]),
	),
	sortDir: Schema.optional(Schema.Literals(["asc", "desc"])),
	limit: Schema.optional(Schema.Number),
	offset: Schema.optional(Schema.Number),
})
export type PodsInput = typeof PodsInput.Type

export const fetchPods = (input: PodsInput) =>
	listPods({ data: input satisfies ListPodsInput }).pipe(
		Effect.map(({ data, totalCount }) => ({ data, totalCount })),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

export const RestartsInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	podNames: StringList,
	namespace: Schema.optional(Schema.String),
	limit: Schema.optional(Schema.Number),
})
export type RestartsInput = typeof RestartsInput.Type

export const fetchRestarts = (input: RestartsInput) =>
	podRestarts({ data: input satisfies PodRestartsInput }).pipe(
		Effect.map((response) => response.data),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

export const PodSummary = PodDetailSummaryResponse.fields.data
export type PodSummary = PodDetailSummaryResponse["data"]

export const PodSummaryInput = Schema.Struct({
	podName: Schema.String,
	namespace: Schema.optional(Schema.String),
	startTime: Schema.String,
	endTime: Schema.String,
})
export type PodSummaryInput = typeof PodSummaryInput.Type

export const fetchPodSummary = (input: PodSummaryInput) =>
	podDetailSummary({ data: input }).pipe(
		Effect.map((response) => response.data),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

export const PodMetric = Schema.Literals([
	"cpu_usage",
	"cpu_limit",
	"cpu_request",
	"memory_limit",
	"memory_request",
])
export type PodMetric = typeof PodMetric.Type

export const PodSeriesInput = Schema.Struct({
	podName: Schema.String,
	namespace: Schema.optional(Schema.String),
	metric: PodMetric,
	startTime: Schema.String,
	endTime: Schema.String,
	bucketSeconds: Schema.Number,
})
export type PodSeriesInput = typeof PodSeriesInput.Type

export const fetchPodSeries = (input: PodSeriesInput) =>
	podInfraTimeseries({ data: input }).pipe(
		Effect.map((response) => ({ rows: response.data, unit: response.unit })),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

/** `POD_METRIC_LABELS`. */
export const POD_METRIC_LABELS = new Map<PodMetric, string>([
	["cpu_usage", "CPU usage"],
	["cpu_limit", "CPU / limit"],
	["cpu_request", "CPU / request"],
	["memory_limit", "Memory / limit"],
	["memory_request", "Memory / request"],
])

/** `PAGE_RESTARTS_LIMIT`: a page of 50 pods with a few containers each. */
export const PAGE_RESTARTS_LIMIT = 500
