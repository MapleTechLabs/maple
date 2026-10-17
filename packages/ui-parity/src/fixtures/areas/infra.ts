import { DateTime, Effect } from "effect"
import {
	containerMetricSpec,
	hostMetricSpec,
	nodeMetricSpec,
	podMetricSpec,
	workloadMetricSpec,
} from "@maple/backend/queries/query-helpers"
import {
	ContainerDetailSummaryRequest,
	ContainerDetailSummaryResponse,
	ContainerFacetsRequest,
	ContainerFacetsResponse,
	ContainerInfraTimeseriesRequest,
	ContainerInfraTimeseriesResponse,
	HostDetailSummaryRequest,
	HostDetailSummaryResponse,
	HostInfraTimeseriesRequest,
	HostInfraTimeseriesResponse,
	ListContainersRequest,
	ListContainersResponse,
	ListNodesRequest,
	ListNodesResponse,
	ListPodsRequest,
	ListPodsResponse,
	ListWorkloadsRequest,
	ListWorkloadsResponse,
	NodeDetailSummaryRequest,
	NodeDetailSummaryResponse,
	NodeFacetsRequest,
	NodeFacetsResponse,
	NodeInfraTimeseriesRequest,
	NodeInfraTimeseriesResponse,
	PodDetailSummaryRequest,
	PodDetailSummaryResponse,
	PodFacetsRequest,
	PodFacetsResponse,
	PodInfraTimeseriesRequest,
	PodInfraTimeseriesResponse,
	PodRestartsRequest,
	PodRestartsResponse,
	WorkloadDetailSummaryRequest,
	WorkloadDetailSummaryResponse,
	WorkloadFacetsRequest,
	WorkloadFacetsResponse,
	WorkloadInfraTimeseriesRequest,
	WorkloadInfraTimeseriesResponse,
} from "@maple/domain/http"
import type { CH } from "@maple/query-engine"
import { defineQuery, Queries } from "@maple/query-engine/registry"
import * as CHQ from "@maple/query-engine/ch"
import type { OrgId } from "@maple/domain"
import { warehouseEndpoint } from "../../backend/endpoints/run.ts"
import type { FixtureWarehouse } from "../../backend/warehouse.ts"
import type { FixtureArea } from "../areas.ts"
import type { Dataset, EndpointHandler } from "../dataset.ts"
import { acmeAdmin, FROZEN_NOW } from "../identity.ts"
import { acmeShopTelemetry } from "../telemetry/acme-shop.ts"
import { infraK8sMetrics } from "../telemetry/infra-k8s.ts"

/**
 * Host, Kubernetes and container pages: the `HttpQueryEngineLive` handlers mirrored over the
 * fixture warehouse. `infra-k8s` is Acme Shop's cluster with kubeletstats and docker metrics.
 */

const iso = (value: DateTime.Utc) => DateTime.formatIso(value)

interface FacetRow {
	readonly facetType: string
	readonly name: string
	readonly count: number
}

/** One arm of the handlers' facet `switch`: the rows of one `facetType`. */
const facet = (rows: ReadonlyArray<FacetRow>, facetType: string) =>
	rows.filter((row) => row.facetType === facetType).map((row) => ({ name: row.name, count: row.count || 0 }))

const nodeCapacity = (row: CH.NodeCapacityOutput) => ({
	cpuUsage: row.cpuUsage || 0,
	cpuAllocatable: row.cpuAllocatable || 0,
	cpuUtilization: row.cpuUtilization || 0,
	memoryUsage: row.memoryUsage || 0,
	memoryAllocatable: row.memoryAllocatable || 0,
	memoryUtilization: row.memoryUtilization || 0,
	uptime: row.uptime || 0,
})

/** The window and bucket every infra timeseries def compiles with (`apps/api/src/routes/queries.ts`). */
const windowParams = (
	payload: { readonly startTime: string; readonly endTime: string; readonly bucketSeconds?: number | undefined },
	orgId: OrgId,
) => ({ orgId, startTime: payload.startTime, endTime: payload.endTime, bucketSeconds: payload.bucketSeconds ?? 60 })

/** The API-side defs (`apps/api/src/routes/queries.ts`) the timeseries handlers run; not in the shared registry. */
const ApiQueries = {
	hostInfraNetworkTimeseries: defineQuery({
		id: "hostInfraTimeseries",
		profile: "aggregation",
		cache: 15,
		compile: (payload: HostInfraTimeseriesRequest, orgId: OrgId) =>
			CHQ.compile(CHQ.hostNetworkTimeseriesQuery({ hostName: payload.hostName }), windowParams(payload, orgId)),
	}),
	hostInfraGaugeTimeseries: defineQuery({
		id: "hostInfraTimeseries",
		profile: "aggregation",
		cache: 15,
		compile: (payload: HostInfraTimeseriesRequest, orgId: OrgId) => {
			const spec = hostMetricSpec(payload.metric)
			return CHQ.compile(
				CHQ.hostGaugeTimeseriesQuery({
					hostName: payload.hostName,
					metricName: spec.metricName,
					groupByAttributeKey: spec.groupByAttributeKey,
					attributeEquals: spec.attributeEquals,
				}),
				windowParams(payload, orgId),
			)
		},
	}),
	containerInfraSumTimeseries: defineQuery({
		id: "containerInfraTimeseries",
		profile: "aggregation",
		cache: 15,
		compile: (payload: ContainerInfraTimeseriesRequest, orgId: OrgId) => {
			const spec = containerMetricSpec(payload.metric)
			return CHQ.compile(
				CHQ.containerSumTimeseriesQuery({
					containerName: payload.containerName,
					hostName: payload.hostName,
					metricNames: spec.metricNames,
					metricLabels: spec.metricLabels,
					groupByAttributeKey: spec.groupByAttributeKey,
					average: spec.average,
				}),
				windowParams(payload, orgId),
			)
		},
	}),
	containerInfraGaugeTimeseries: defineQuery({
		id: "containerInfraTimeseries",
		profile: "aggregation",
		cache: 15,
		compile: (payload: ContainerInfraTimeseriesRequest, orgId: OrgId) => {
			const spec = containerMetricSpec(payload.metric)
			return CHQ.compile(
				CHQ.containerGaugeTimeseriesQuery({
					containerName: payload.containerName,
					hostName: payload.hostName,
					metricName: spec.metricNames[0],
					divideBy: spec.divideBy,
				}),
				windowParams(payload, orgId),
			)
		},
	}),
	podInfraTimeseries: defineQuery({
		id: "podInfraTimeseries",
		profile: "aggregation",
		cache: 15,
		compile: (payload: PodInfraTimeseriesRequest, orgId: OrgId) =>
			CHQ.compile(
				CHQ.podGaugeTimeseriesQuery({
					podName: payload.podName,
					namespace: payload.namespace,
					metricName: podMetricSpec(payload.metric).metricName,
				}),
				windowParams(payload, orgId),
			),
	}),
	nodeInfraTimeseries: defineQuery({
		id: "nodeInfraTimeseries",
		profile: "aggregation",
		cache: 15,
		compile: (payload: NodeInfraTimeseriesRequest, orgId: OrgId) =>
			CHQ.compile(
				CHQ.nodeGaugeTimeseriesQuery({ nodeName: payload.nodeName, ...nodeMetricSpec(payload.metric) }),
				windowParams(payload, orgId),
			),
	}),
	workloadInfraTimeseries: defineQuery({
		id: "workloadInfraTimeseries",
		profile: "aggregation",
		cache: 15,
		compile: (payload: WorkloadInfraTimeseriesRequest, orgId: OrgId) =>
			CHQ.compile(
				CHQ.workloadGaugeTimeseriesQuery({
					kind: payload.kind,
					workloadName: payload.workloadName,
					namespace: payload.namespace,
					metricName: workloadMetricSpec(payload.metric).metricName,
					groupByPod: payload.groupByPod,
				}),
				windowParams(payload, orgId),
			),
	}),
}

const timeseriesPoint = (row: { readonly bucket: DateTime.Utc; readonly attributeValue: string; readonly avgValue: number | null }) => ({
	bucket: iso(row.bucket),
	attributeValue: row.attributeValue,
	value: Number(row.avgValue) || 0,
})

const hostEndpoints = (warehouse: FixtureWarehouse): Readonly<Record<string, EndpointHandler>> => ({
	"queryEngine.hostDetailSummary": warehouseEndpoint(warehouse, HostDetailSummaryRequest, HostDetailSummaryResponse, (payload, { runQueryFirst }) =>
		Effect.map(
			runQueryFirst(Queries.hostDetailSummary, payload),
			(row) =>
				new HostDetailSummaryResponse({
					data: row
						? {
								hostName: row.hostName,
								osType: row.osType,
								hostArch: row.hostArch,
								cloudProvider: row.cloudProvider,
								cloudRegion: row.cloudRegion,
								firstSeen: iso(row.firstSeen),
								lastSeen: iso(row.lastSeen),
								cpuPct: row.cpuPct || 0,
								memoryPct: row.memoryPct || 0,
								diskPct: row.diskPct || 0,
								load15: row.load15 || 0,
							}
						: null,
				}),
		),
	),
	"queryEngine.hostInfraTimeseries": warehouseEndpoint(warehouse, HostInfraTimeseriesRequest, HostInfraTimeseriesResponse, (payload, { runQuery }) => {
		const spec = hostMetricSpec(payload.metric)
		const meta = { unit: spec.unit, ...(spec.groupByAttributeKey === undefined ? {} : { groupByAttributeKey: spec.groupByAttributeKey }) }
		return spec.isNetwork
			? Effect.map(runQuery(ApiQueries.hostInfraNetworkTimeseries, payload), (rows) =>
					new HostInfraTimeseriesResponse({
						data: rows.map((row) => ({ bucket: iso(row.bucket), attributeValue: row.attributeValue, value: row.sumValue || 0 })),
						...meta,
					}),
				)
			: Effect.map(runQuery(ApiQueries.hostInfraGaugeTimeseries, payload), (rows) =>
					new HostInfraTimeseriesResponse({ data: rows.map(timeseriesPoint), ...meta }),
				)
	}),
})

/** `listPods` total: the denominator follows the scope or lifecycle the list ran with. */
const podTotal = (payload: ListPodsRequest, count: CH.ListPodsSummaryOutput | null, rows: number) =>
	Number(
		payload.scope === "saturated"
			? count?.saturatedPods
			: payload.scope === "elevated"
				? count?.elevatedPods
				: payload.scope === "unbounded"
					? count?.unboundedPods
					: payload.lifecycle === "ended"
						? count?.endedPods
						: payload.lifecycle === "all"
							? (count?.livePods ?? 0) + (count?.endedPods ?? 0)
							: count?.livePods,
	) || rows

const podEndpoints = (warehouse: FixtureWarehouse): Readonly<Record<string, EndpointHandler>> => ({
	"queryEngine.listPods": warehouseEndpoint(warehouse, ListPodsRequest, ListPodsResponse, (payload, { runQuery, runQueryFirst }) =>
		Effect.map(
			Effect.all([runQuery(Queries.listPods, payload), runQueryFirst(Queries.listPodsCount, payload)]),
			([rows, count]) =>
				new ListPodsResponse({
					data: rows.map((row) => ({
						podName: row.podName,
						namespace: row.namespace,
						nodeName: row.nodeName,
						clusterName: row.clusterName,
						environment: row.environment,
						deploymentName: row.deploymentName,
						statefulsetName: row.statefulsetName,
						daemonsetName: row.daemonsetName,
						jobName: row.jobName,
						qosClass: row.qosClass,
						podUid: row.podUid,
						computeType: row.computeType,
						lastSeen: iso(row.lastSeen),
						cpuUsage: row.cpuUsage || 0,
						cpuLimitPct: row.cpuLimitPct || 0,
						memoryLimitPct: row.memoryLimitPct || 0,
						cpuRequestPct: row.cpuRequestPct || 0,
						memoryRequestPct: row.memoryRequestPct || 0,
						cpuUsagePeak: row.cpuUsagePeak || 0,
						cpuLimitPctPeak: row.cpuLimitPctPeak || 0,
						memoryLimitPctPeak: row.memoryLimitPctPeak || 0,
						saturation: row.saturation || 0,
					})),
					totalCount: podTotal(payload, count, rows.length),
				}),
		),
	),
	"queryEngine.podFacets": warehouseEndpoint(warehouse, PodFacetsRequest, PodFacetsResponse, (payload, { runQuery }) =>
		Effect.map(
			runQuery(Queries.podFacets, payload),
			(rows) =>
				new PodFacetsResponse({
					data: {
						pods: facet(rows, "pod"),
						namespaces: facet(rows, "namespace"),
						nodes: facet(rows, "node"),
						clusters: facet(rows, "cluster"),
						deployments: facet(rows, "deployment"),
						statefulsets: facet(rows, "statefulset"),
						daemonsets: facet(rows, "daemonset"),
						jobs: facet(rows, "job"),
						environments: facet(rows, "environment"),
						computeTypes: facet(rows, "computeType"),
					},
				}),
		),
	),
	"queryEngine.podDetailSummary": warehouseEndpoint(warehouse, PodDetailSummaryRequest, PodDetailSummaryResponse, (payload, { runQueryFirst }) =>
		Effect.map(
			runQueryFirst(Queries.podDetailSummary, payload),
			(row) =>
				new PodDetailSummaryResponse({
					data: row
						? {
								podName: row.podName,
								namespace: row.namespace,
								nodeName: row.nodeName,
								deploymentName: row.deploymentName,
								statefulsetName: row.statefulsetName,
								daemonsetName: row.daemonsetName,
								qosClass: row.qosClass,
								podUid: row.podUid,
								computeType: row.computeType,
								podStartTime: row.podStartTime,
								firstSeen: iso(row.firstSeen),
								lastSeen: iso(row.lastSeen),
								cpuUsage: row.cpuUsage || 0,
								cpuLimitPct: row.cpuLimitPct || 0,
								memoryLimitPct: row.memoryLimitPct || 0,
								cpuRequestPct: row.cpuRequestPct || 0,
								memoryRequestPct: row.memoryRequestPct || 0,
							}
						: null,
				}),
		),
	),
	"queryEngine.podRestarts": warehouseEndpoint(warehouse, PodRestartsRequest, PodRestartsResponse, (payload, { runQuery }) =>
		Effect.map(
			runQuery(Queries.podRestarts, payload),
			(rows) =>
				new PodRestartsResponse({
					data: rows.map((row) => ({
						podName: row.podName,
						namespace: row.namespace,
						containerName: row.containerName,
						restarts: Number(row.restarts) || 0,
						totalRestarts: Number(row.totalRestarts) || 0,
						lastTerminatedReason: row.lastTerminatedReason,
					})),
				}),
		),
	),
	"queryEngine.podInfraTimeseries": warehouseEndpoint(warehouse, PodInfraTimeseriesRequest, PodInfraTimeseriesResponse, (payload, { runQuery }) =>
		Effect.map(
			runQuery(ApiQueries.podInfraTimeseries, payload),
			(rows) => new PodInfraTimeseriesResponse({ data: rows.map(timeseriesPoint), unit: podMetricSpec(payload.metric).unit }),
		),
	),
})

const nodeEndpoints = (warehouse: FixtureWarehouse): Readonly<Record<string, EndpointHandler>> => ({
	"queryEngine.listNodes": warehouseEndpoint(warehouse, ListNodesRequest, ListNodesResponse, (payload, { runQuery }) =>
		Effect.map(
			runQuery(Queries.listNodes, payload),
			(rows) =>
				new ListNodesResponse({
					data: rows.map((row) => ({
						nodeName: row.nodeName,
						nodeUid: row.nodeUid,
						clusterName: row.clusterName,
						environment: row.environment,
						kubeletVersion: row.kubeletVersion,
						lastSeen: iso(row.lastSeen),
						...nodeCapacity(row),
					})),
				}),
		),
	),
	"queryEngine.nodeFacets": warehouseEndpoint(warehouse, NodeFacetsRequest, NodeFacetsResponse, (payload, { runQuery }) =>
		Effect.map(
			runQuery(Queries.nodeFacets, payload),
			(rows) =>
				new NodeFacetsResponse({
					data: { nodes: facet(rows, "node"), clusters: facet(rows, "cluster"), environments: facet(rows, "environment") },
				}),
		),
	),
	"queryEngine.nodeDetailSummary": warehouseEndpoint(warehouse, NodeDetailSummaryRequest, NodeDetailSummaryResponse, (payload, { runQueryFirst }) =>
		Effect.map(
			runQueryFirst(Queries.nodeDetailSummary, payload),
			(row) =>
				new NodeDetailSummaryResponse({
					data: row
						? {
								nodeName: row.nodeName,
								nodeUid: row.nodeUid,
								kubeletVersion: row.kubeletVersion,
								containerRuntime: row.containerRuntime,
								firstSeen: iso(row.firstSeen),
								lastSeen: iso(row.lastSeen),
								...nodeCapacity(row),
							}
						: null,
				}),
		),
	),
	"queryEngine.nodeInfraTimeseries": warehouseEndpoint(warehouse, NodeInfraTimeseriesRequest, NodeInfraTimeseriesResponse, (payload, { runQuery }) =>
		Effect.map(
			runQuery(ApiQueries.nodeInfraTimeseries, payload),
			(rows) => new NodeInfraTimeseriesResponse({ data: rows.map(timeseriesPoint), unit: nodeMetricSpec(payload.metric).unit }),
		),
	),
})

const workloadEndpoints = (warehouse: FixtureWarehouse): Readonly<Record<string, EndpointHandler>> => ({
	"queryEngine.listWorkloads": warehouseEndpoint(warehouse, ListWorkloadsRequest, ListWorkloadsResponse, (payload, { runQuery }) =>
		Effect.map(
			runQuery(Queries.listWorkloads, payload),
			(rows) =>
				new ListWorkloadsResponse({
					data: rows.map((row) => ({
						workloadName: row.workloadName,
						namespace: row.namespace,
						clusterName: row.clusterName,
						environment: row.environment,
						podCount: row.podCount || 0,
						lastSeen: iso(row.lastSeen),
						desiredReplicas: row.replicaSamples > 0 ? row.desiredReplicas : null,
						readyReplicas: row.replicaSamples > 0 ? row.readyReplicas : null,
						failedPods: row.failedPods || 0,
						restarts: row.restarts || 0,
						lastTerminatedReason: row.lastTerminatedReason,
						peakCpuLimitPct: row.peakCpuLimitPct || 0,
						peakMemoryLimitPct: row.peakMemoryLimitPct || 0,
						cpuUsage: row.cpuUsage || 0,
					})),
				}),
		),
	),
	"queryEngine.workloadFacets": warehouseEndpoint(warehouse, WorkloadFacetsRequest, WorkloadFacetsResponse, (payload, { runQuery }) =>
		Effect.map(
			runQuery(Queries.workloadFacets, payload),
			(rows) =>
				new WorkloadFacetsResponse({
					data: {
						workloads: facet(rows, "workload"),
						namespaces: facet(rows, "namespace"),
						clusters: facet(rows, "cluster"),
						environments: facet(rows, "environment"),
						computeTypes: facet(rows, "computeType"),
					},
				}),
		),
	),
	"queryEngine.workloadDetailSummary": warehouseEndpoint(warehouse, WorkloadDetailSummaryRequest, WorkloadDetailSummaryResponse, (payload, { runQueryFirst }) =>
		Effect.map(
			runQueryFirst(Queries.workloadDetailSummary, payload),
			(row) =>
				new WorkloadDetailSummaryResponse({
					data: row
						? {
								workloadName: row.workloadName,
								kind: payload.kind,
								namespace: row.namespace,
								podCount: row.podCount || 0,
								firstSeen: iso(row.firstSeen),
								lastSeen: iso(row.lastSeen),
								avgCpuLimitPct: row.avgCpuLimitPct || 0,
								avgMemoryLimitPct: row.avgMemoryLimitPct || 0,
								avgCpuUsage: row.avgCpuUsage || 0,
							}
						: null,
				}),
		),
	),
	"queryEngine.workloadInfraTimeseries": warehouseEndpoint(warehouse, WorkloadInfraTimeseriesRequest, WorkloadInfraTimeseriesResponse, (payload, { runQuery }) =>
		Effect.map(
			runQuery(ApiQueries.workloadInfraTimeseries, payload),
			(rows) => new WorkloadInfraTimeseriesResponse({ data: rows.map(timeseriesPoint), unit: workloadMetricSpec(payload.metric).unit }),
		),
	),
})

const containerTotal = (payload: ListContainersRequest, count: CH.ListContainersSummaryOutput | null, rows: number) =>
	Number(
		payload.scope === "saturated"
			? count?.saturatedContainers
			: payload.scope === "elevated"
				? count?.elevatedContainers
				: payload.scope === "stale"
					? count?.staleContainers
					: count?.totalContainers,
	) || rows

const containerEndpoints = (warehouse: FixtureWarehouse): Readonly<Record<string, EndpointHandler>> => ({
	"queryEngine.listContainers": warehouseEndpoint(warehouse, ListContainersRequest, ListContainersResponse, (payload, { runQuery, runQueryFirst }) =>
		Effect.map(
			Effect.all([runQuery(Queries.listContainers, payload), runQueryFirst(Queries.listContainersCount, payload)]),
			([rows, count]) =>
				new ListContainersResponse({
					data: rows.map((row) => ({
						containerName: row.containerName,
						hostName: row.hostName,
						containerId: row.containerId,
						imageName: row.imageName,
						composeProject: row.composeProject,
						composeService: row.composeService,
						runtime: row.runtime,
						environment: row.environment,
						lastSeen: iso(row.lastSeen),
						cpuPct: row.cpuPct || 0,
						memoryPct: row.memoryPct || 0,
						cpuPctPeak: row.cpuPctPeak || 0,
						memoryPctPeak: row.memoryPctPeak || 0,
						cpuLimitCores: row.cpuLimitCores || 0,
						uptimeSeconds: row.uptimeSeconds || 0,
						saturation: row.saturation || 0,
					})),
					totalCount: containerTotal(payload, count, rows.length),
				}),
		),
	),
	"queryEngine.containerFacets": warehouseEndpoint(warehouse, ContainerFacetsRequest, ContainerFacetsResponse, (payload, { runQuery }) =>
		Effect.map(
			runQuery(Queries.containerFacets, payload),
			(rows) =>
				new ContainerFacetsResponse({
					data: {
						containers: facet(rows, "container"),
						hosts: facet(rows, "host"),
						images: facet(rows, "image"),
						composeProjects: facet(rows, "composeProject"),
						composeServices: facet(rows, "composeService"),
						environments: facet(rows, "environment"),
					},
				}),
		),
	),
	"queryEngine.containerDetailSummary": warehouseEndpoint(
		warehouse,
		ContainerDetailSummaryRequest,
		ContainerDetailSummaryResponse,
		(payload, { runQueryFirst }) =>
			Effect.map(
				Effect.all([runQueryFirst(Queries.containerDetailSummary, payload), runQueryFirst(Queries.containerCountersSummary, payload)]),
				([row, counters]) =>
					new ContainerDetailSummaryResponse({
						data: row
							? {
									containerName: row.containerName,
									hostName: row.hostName,
									containerId: row.containerId,
									imageName: row.imageName,
									composeProject: row.composeProject,
									composeService: row.composeService,
									runtime: row.runtime,
									firstSeen: iso(row.firstSeen),
									lastSeen: iso(row.lastSeen),
									cpuPct: row.cpuPct || 0,
									memoryPct: row.memoryPct || 0,
									cpuLimitCores: row.cpuLimitCores || 0,
									uptimeSeconds: row.uptimeSeconds || 0,
									memoryBytesAvg: Number(counters?.memoryBytesAvg) || 0,
									memoryLimitBytes: Number(counters?.memoryLimitBytes) || 0,
									restartsDelta: Number(counters?.restartsDelta) || 0,
									pidsAvg: Number(counters?.pidsAvg) || 0,
								}
							: null,
					}),
			),
	),
	"queryEngine.containerInfraTimeseries": warehouseEndpoint(
		warehouse,
		ContainerInfraTimeseriesRequest,
		ContainerInfraTimeseriesResponse,
		(payload, { runQuery }) => {
			const spec = containerMetricSpec(payload.metric)
			return spec.isSum
				? Effect.map(runQuery(ApiQueries.containerInfraSumTimeseries, payload), (rows) =>
						new ContainerInfraTimeseriesResponse({
							data: rows.map((row) => ({ bucket: iso(row.bucket), attributeValue: row.attributeValue, value: Number(row.sumValue) || 0 })),
							unit: spec.unit,
						}),
					)
				: Effect.map(runQuery(ApiQueries.containerInfraGaugeTimeseries, payload), (rows) =>
						new ContainerInfraTimeseriesResponse({ data: rows.map(timeseriesPoint), unit: spec.unit }),
					)
		},
	),
})

const INFRA_ORG = "org_parity_infra"

/** Acme Shop again (fewer traces), under its own org, plus the cluster and a Compose host. */
const infraK8sDataset: Dataset = (() => {
	const now = new Date(FROZEN_NOW)
	const acme = acmeShopTelemetry({ orgId: INFRA_ORG, now, hours: 13, peakTracesPerMinute: 2, seed: 11 })
	const infra = infraK8sMetrics({ orgId: INFRA_ORG, now, seed: 23 })
	return {
		name: "infra-k8s",
		now: FROZEN_NOW,
		identity: { ...acmeAdmin, orgId: INFRA_ORG, orgSlug: "acme-shop-infra" },
		auth: "self_hosted",
		endpoints: {},
		synced: {},
		telemetry: {
			...acme,
			metrics_gauge: [...acme.metrics_gauge, ...infra.metrics_gauge],
			metrics_sum: [...acme.metrics_sum, ...infra.metrics_sum],
		},
	}
})()

export const fixtureArea: FixtureArea = {
	area: "infra",
	endpoints: (warehouse) => ({
		...hostEndpoints(warehouse),
		...podEndpoints(warehouse),
		...nodeEndpoints(warehouse),
		...workloadEndpoints(warehouse),
		...containerEndpoints(warehouse),
	}),
	datasets: [infraK8sDataset],
}
