import { DateTime, Effect } from "effect"
import {
	ContainersSummaryRequest,
	ContainersSummaryResponse,
	ListHostsRequest,
	ListHostsResponse,
	PodsSummaryRequest,
	PodsSummaryResponse,
} from "@maple/domain/http"
import { Queries } from "@maple/query-engine/registry"
import type { EndpointHandler } from "../../fixtures/dataset.ts"
import type { FixtureWarehouse } from "../warehouse.ts"
import { warehouseEndpoint } from "./run.ts"

/** The /infra overview's host, pod and container reads from `HttpQueryEngineLive`. */
export const infraEndpoints = (warehouse: FixtureWarehouse): Readonly<Record<string, EndpointHandler>> => ({
	"queryEngine.listHosts": warehouseEndpoint(
		warehouse,
		ListHostsRequest,
		ListHostsResponse,
		(payload, { runQuery }) =>
			Effect.map(
				runQuery(Queries.listHosts, payload),
				(rows) =>
					new ListHostsResponse({
						data: rows.map((row) => ({
							hostName: row.hostName,
							osType: row.osType,
							hostArch: row.hostArch,
							cloudProvider: row.cloudProvider,
							lastSeen: DateTime.formatIso(row.lastSeen),
							cpuPct: row.cpuPct || 0,
							memoryPct: row.memoryPct || 0,
							diskPct: row.diskPct || 0,
							load15: row.load15 || 0,
						})),
					}),
			),
	),
	"queryEngine.podsSummary": warehouseEndpoint(
		warehouse,
		PodsSummaryRequest,
		PodsSummaryResponse,
		(payload, { runQueryFirst }) =>
			Effect.map(
				runQueryFirst(Queries.podsSummary, payload),
				(row) =>
					new PodsSummaryResponse({
						livePods: Number(row?.livePods) || 0,
						endedPods: Number(row?.endedPods) || 0,
						saturatedPods: Number(row?.saturatedPods) || 0,
						elevatedPods: Number(row?.elevatedPods) || 0,
						unboundedPods: Number(row?.unboundedPods) || 0,
					}),
			),
	),
	"queryEngine.containersSummary": warehouseEndpoint(
		warehouse,
		ContainersSummaryRequest,
		ContainersSummaryResponse,
		(payload, { runQueryFirst }) =>
			Effect.map(
				runQueryFirst(Queries.containersSummary, payload),
				(row) =>
					new ContainersSummaryResponse({
						totalContainers: Number(row?.totalContainers) || 0,
						saturatedContainers: Number(row?.saturatedContainers) || 0,
						elevatedContainers: Number(row?.elevatedContainers) || 0,
						staleContainers: Number(row?.staleContainers) || 0,
					}),
			),
	),
})
