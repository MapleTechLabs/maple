import { Effect } from "effect"
import { GetLogRequest, GetLogResponse } from "@maple/domain/http"
import { CH } from "@maple/query-engine"
import { partitionWindowAround, warehouseEndpoint } from "../../backend/endpoints/run.ts"
import type { FixtureArea } from "../areas.ts"

/** `/logs/$logId`'s read: the API's `getLog` query (by key, in the timestamp's partition window). */
export const fixtureArea: FixtureArea = {
	area: "logs",
	endpoints: (warehouse) => ({
		"queryEngine.getLog": warehouseEndpoint(
			warehouse,
			GetLogRequest,
			GetLogResponse,
			(payload, { tenant }) => {
				const { startTime, endTime } = partitionWindowAround(payload.timestamp)
				return Effect.map(
					warehouse.executor.compiledQuery(
						tenant,
						CH.compile(
							CH.getLogByKeyQuery({
								serviceName: payload.serviceName,
								traceId: payload.traceId,
								spanId: payload.spanId,
							}),
							{ orgId: tenant.orgId, startTime, endTime, timestamp: payload.timestamp },
						),
						{ profile: "list", context: "getLog" },
					),
					(rows) => new GetLogResponse({ data: rows }),
				)
			},
		),
	}),
}
