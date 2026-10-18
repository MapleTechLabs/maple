import { ListPodsResponse, PodRestartsResponse } from "@maple/domain/http"
import { summarizePodRestarts } from "@maple/web/components/infra/pod-restarts"
import { listPods, podRestarts, type ListPodsInput, type PodRestartsInput } from "@maple/web-data/warehouse/infra"
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

/** `PAGE_RESTARTS_LIMIT`: a page of 50 pods with a few containers each. */
export const PAGE_RESTARTS_LIMIT = 500

export { summarizePodRestarts }
