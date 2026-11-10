import {
	HostDetailSummaryRequest,
	HostInfraTimeseriesRequest,
	InfraPresenceRequest,
	ListHostsRequest,
	ListPodsRequest,
	PodsSummaryRequest,
	PodDetailSummaryRequest,
	PodRestartsRequest,
	PodInfraTimeseriesRequest,
	PodFacetsRequest,
	ListNodesRequest,
	NodeDetailSummaryRequest,
	NodeInfraTimeseriesRequest,
	NodeFacetsRequest,
	ListWorkloadsRequest,
	WorkloadDetailSummaryRequest,
	WorkloadInfraTimeseriesRequest,
	WorkloadFacetsRequest,
	ListContainersRequest,
	ContainersSummaryRequest,
	ContainerDetailSummaryRequest,
	ContainerInfraTimeseriesRequest,
	ContainerFacetsRequest,
} from "@maple/domain/http"
import { Effect } from "effect"
import { MapleInternalHttp } from "./warehouse-services"
import { runWarehouseQuery, type RequestInput } from "./effect-utils"

/** Which Infrastructure surfaces report telemetry — the sidebar's visibility gate. */
export function infraPresence({ data }: { data: RequestInput<typeof InfraPresenceRequest> }) {
	return runWarehouseQuery("infraPresence", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.infraPresence({
				payload: new InfraPresenceRequest(data),
			})
		}),
	)
}

export function listHosts({ data }: { data: RequestInput<typeof ListHostsRequest> }) {
	return runWarehouseQuery("listHosts", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.listHosts({
				payload: new ListHostsRequest(data),
			})
		}),
	)
}

export function hostDetailSummary({ data }: { data: RequestInput<typeof HostDetailSummaryRequest> }) {
	return runWarehouseQuery("hostDetailSummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.hostDetailSummary({
				payload: new HostDetailSummaryRequest(data),
			})
		}),
	)
}

export type HostInfraMetric = HostInfraTimeseriesRequest["metric"]

export function hostInfraTimeseries({ data }: { data: RequestInput<typeof HostInfraTimeseriesRequest> }) {
	return runWarehouseQuery("hostInfraTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.hostInfraTimeseries({
				payload: new HostInfraTimeseriesRequest(data),
			})
		}),
	)
}

export type ListPodsInput = RequestInput<typeof ListPodsRequest>

export function listPods({ data }: { data: RequestInput<typeof ListPodsRequest> }) {
	return runWarehouseQuery("listPods", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.listPods({
				payload: new ListPodsRequest(data),
			})
		}),
	)
}

export type PodsSummaryInput = RequestInput<typeof PodsSummaryRequest>

/**
 * Fleet-shape counts for the browse summary band. Deliberately scope-only — it
 * answers "how much of the fleet did my filters hide", which a filtered count
 * cannot.
 */
export function podsSummary({ data }: { data: RequestInput<typeof PodsSummaryRequest> }) {
	return runWarehouseQuery("podsSummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.podsSummary({
				payload: new PodsSummaryRequest(data),
			})
		}),
	)
}

export function getPodFacets({ data }: { data: RequestInput<typeof PodFacetsRequest> }) {
	return runWarehouseQuery("podFacets", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.podFacets({
				payload: new PodFacetsRequest(data),
			})
		}),
	)
}

export function podDetailSummary({ data }: { data: RequestInput<typeof PodDetailSummaryRequest> }) {
	return runWarehouseQuery("podDetailSummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.podDetailSummary({
				payload: new PodDetailSummaryRequest(data),
			})
		}),
	)
}

export type PodRestartsInput = RequestInput<typeof PodRestartsRequest>

export function podRestarts({ data }: { data: RequestInput<typeof PodRestartsRequest> }) {
	return runWarehouseQuery("podRestarts", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.podRestarts({
				payload: new PodRestartsRequest(data),
			})
		}),
	)
}

export type PodInfraMetric = PodInfraTimeseriesRequest["metric"]

export function podInfraTimeseries({ data }: { data: RequestInput<typeof PodInfraTimeseriesRequest> }) {
	return runWarehouseQuery("podInfraTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.podInfraTimeseries({
				payload: new PodInfraTimeseriesRequest(data),
			})
		}),
	)
}

export function listNodes({ data }: { data: RequestInput<typeof ListNodesRequest> }) {
	return runWarehouseQuery("listNodes", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.listNodes({
				payload: new ListNodesRequest(data),
			})
		}),
	)
}

export function getNodeFacets({ data }: { data: RequestInput<typeof NodeFacetsRequest> }) {
	return runWarehouseQuery("nodeFacets", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.nodeFacets({
				payload: new NodeFacetsRequest(data),
			})
		}),
	)
}

export function nodeDetailSummary({ data }: { data: RequestInput<typeof NodeDetailSummaryRequest> }) {
	return runWarehouseQuery("nodeDetailSummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.nodeDetailSummary({
				payload: new NodeDetailSummaryRequest(data),
			})
		}),
	)
}

export type NodeInfraMetric = NodeInfraTimeseriesRequest["metric"]

export function nodeInfraTimeseries({ data }: { data: RequestInput<typeof NodeInfraTimeseriesRequest> }) {
	return runWarehouseQuery("nodeInfraTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.nodeInfraTimeseries({
				payload: new NodeInfraTimeseriesRequest(data),
			})
		}),
	)
}

// Containers (Docker)

export type ListContainersInput = RequestInput<typeof ListContainersRequest>

export function listContainers({ data }: { data: ListContainersInput }) {
	return runWarehouseQuery("listContainers", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.listContainers({
				payload: new ListContainersRequest(data),
			})
		}),
	)
}

export type ContainersSummaryInput = RequestInput<typeof ContainersSummaryRequest>

/** Fleet-shape counts for the containers summary band — scope-only, like podsSummary. */
export function containersSummary({ data }: { data: RequestInput<typeof ContainersSummaryRequest> }) {
	return runWarehouseQuery("containersSummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.containersSummary({
				payload: new ContainersSummaryRequest(data),
			})
		}),
	)
}

export function getContainerFacets({ data }: { data: RequestInput<typeof ContainerFacetsRequest> }) {
	return runWarehouseQuery("containerFacets", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.containerFacets({
				payload: new ContainerFacetsRequest(data),
			})
		}),
	)
}

export function containerDetailSummary({
	data,
}: {
	data: RequestInput<typeof ContainerDetailSummaryRequest>
}) {
	return runWarehouseQuery("containerDetailSummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.containerDetailSummary({
				payload: new ContainerDetailSummaryRequest(data),
			})
		}),
	)
}

export type ContainerInfraMetric = ContainerInfraTimeseriesRequest["metric"]

export function containerInfraTimeseries({
	data,
}: {
	data: RequestInput<typeof ContainerInfraTimeseriesRequest>
}) {
	return runWarehouseQuery("containerInfraTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.containerInfraTimeseries({
				payload: new ContainerInfraTimeseriesRequest(data),
			})
		}),
	)
}

// Workloads (Deployments / StatefulSets / DaemonSets)

export function listWorkloads({ data }: { data: RequestInput<typeof ListWorkloadsRequest> }) {
	return runWarehouseQuery("listWorkloads", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.listWorkloads({
				payload: new ListWorkloadsRequest(data),
			})
		}),
	)
}

export function getWorkloadFacets({ data }: { data: RequestInput<typeof WorkloadFacetsRequest> }) {
	return runWarehouseQuery("workloadFacets", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.workloadFacets({
				payload: new WorkloadFacetsRequest(data),
			})
		}),
	)
}

export function workloadDetailSummary({ data }: { data: RequestInput<typeof WorkloadDetailSummaryRequest> }) {
	return runWarehouseQuery("workloadDetailSummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.workloadDetailSummary({
				payload: new WorkloadDetailSummaryRequest(data),
			})
		}),
	)
}

export type WorkloadInfraMetric = WorkloadInfraTimeseriesRequest["metric"]

export function workloadInfraTimeseries({
	data,
}: {
	data: RequestInput<typeof WorkloadInfraTimeseriesRequest>
}) {
	return runWarehouseQuery("workloadInfraTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.workloadInfraTimeseries({
				payload: new WorkloadInfraTimeseriesRequest(data),
			})
		}),
	)
}
