import { CH, coerceServiceOverviewRows } from "@maple/query-engine"
import { LOCAL_ORG_ID } from "@maple/query-engine/local"
import type { TimeBounds } from "../../lib/time"
import { Effect } from "effect"
import { localParams, queryRows } from "../../data/local-query"
import type { LocalServiceMapData } from "./data"
import { aggregateEdges, classifyPlatform, toDbEdge } from "./rows"

// Everything the map
// draws, from the query-engine builders the cloud map's bundle uses.

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
		const data: LocalServiceMapData = {
			edges: aggregateEdges(edgeRows, durationSeconds),
			dbEdges: dbEdgeRows.map((row) => toDbEdge(row, durationSeconds)),
			overviews: coerceServiceOverviewRows(overviewRows, durationSeconds),
			platforms,
			runtimes,
		}
		return data
	})
