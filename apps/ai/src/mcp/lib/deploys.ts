import { DateTime, Effect } from "effect"
import { CH } from "@maple/query-engine"
import { WarehouseExecutor } from "@maple/query-engine/observability"
import { warehouseToMcpHandlers } from "./map-warehouse-error"
import { withTenantExecutor } from "./query-warehouse"

/**
 * A service's deployed versions (distinct commit SHAs per environment), newest first by the
 * time each version's first span arrived. The source for every "since the deploy" tool.
 */
export const serviceDeploysNewestFirst = (
	tool: string,
	context: string,
	service: string,
	environment: string | undefined,
	startTime: string,
	endTime: string,
) =>
	withTenantExecutor(
		Effect.gen(function* () {
			const executor = yield* WarehouseExecutor
			const rows = yield* executor.compiledQuery(
				CH.compile(
					CH.serviceDeploymentsQuery({
						serviceName: service,
						environments: environment === undefined ? undefined : [environment],
						minutePrecision: false,
						limit: 100,
					}),
					{ orgId: executor.orgId, startTime, endTime },
					{ rowSchema: CH.serviceDeploymentsRowSchema },
				),
				{ profile: "aggregation", context },
			)
			return [...rows].sort(
				(a, b) => DateTime.toEpochMillis(b.firstSeen) - DateTime.toEpochMillis(a.firstSeen),
			)
		}),
	).pipe(Effect.catchTags(warehouseToMcpHandlers(tool)))
