import { CH, coerceServiceOverviewRows, type ServiceOverview } from "@maple/query-engine"
import { LOCAL_ORG_ID } from "@maple/query-engine/local"
import type { TimeBounds } from "@maple/local-ui/lib/time"
import type {
	ServiceMapDbEdgeRow,
	ServiceMapEdgeRow,
	ServicePlatform,
} from "@maple/ui/components/service-map/service-map-types"
import { Effect, Schema } from "effect"
import { localParams, queryRows } from "../../data/local-query"
import { aggregateEdges, classifyPlatform, toDbEdge } from "./rows"

// `useLocalServiceMap` (apps/local-ui/src/hooks/use-local-service-map.ts): everything the map
// draws, from the query-engine builders the cloud map's bundle uses.

/** The rows feed `buildFlowElements` unchanged, so they stay its shapes, boxed as one opaque value. */
export class LocalServiceMapData {
	constructor(
		readonly edges: ReadonlyArray<ServiceMapEdgeRow>,
		readonly dbEdges: ReadonlyArray<ServiceMapDbEdgeRow>,
		/** One row per (service, environment), sampling-corrected like the cloud map's. */
		readonly overviews: ReadonlyArray<ServiceOverview>,
		readonly platforms: ReadonlyMap<string, ServicePlatform>,
		/** `process.runtime.name` per service. */
		readonly runtimes: ReadonlyMap<string, string>,
	) {}
}
export const LocalServiceMapDataSchema = Schema.instanceOf(LocalServiceMapData)

export const fetchServiceMap = (bounds: TimeBounds, durationSeconds: number, apiBase: string) =>
	Effect.gen(function* () {
		const params = localParams(bounds)
		const [edgeRows, dbEdgeRows, overviewRows, platformRows] = yield* Effect.all(
			[
				queryRows(
					CH.serviceMapEdgesRollupSQL({ orgId: LOCAL_ORG_ID, hourStart: bounds.startTime, hourEnd: bounds.endTime }),
					apiBase,
				),
				queryRows(CH.serviceDbEdgesSQL({}, params), apiBase),
				queryRows(CH.compile(CH.serviceOverviewQuery({}), params), apiBase),
				queryRows(CH.servicePlatformsSQL({}, params), apiBase),
			],
			{ concurrency: "unbounded" },
		)
		const platforms = new Map(platformRows.map((row) => [row.serviceName, classifyPlatform(row)] as const))
		const runtimes = new Map(
			platformRows.flatMap((row) => (row.processRuntimeName ? [[row.serviceName, row.processRuntimeName] as const] : [])),
		)
		return new LocalServiceMapData(
			aggregateEdges(edgeRows, durationSeconds),
			dbEdgeRows.map((row) => toDbEdge(row, durationSeconds)),
			coerceServiceOverviewRows(overviewRows, durationSeconds),
			platforms,
			runtimes,
		)
	})
