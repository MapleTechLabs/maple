import type { WarehouseQueryName } from "@maple/domain"
import { WarehouseQueryRequest } from "@maple/domain/http"
import { Effect } from "effect"
import { toMcpQueryError } from "./map-warehouse-error"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import type { WarehouseExecutor } from "@maple/query-engine/observability"
import { provideWarehouseExecutorFromTenant } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { CurrentMcpTenant } from "../tenant"

/** Infrastructure binding: resolves the tenant and installs its WarehouseExecutor facade. */
export const withTenantExecutor = Effect.fn("McpWarehouse.withTenantExecutor")(function* <A, E>(
	effect: Effect.Effect<A, E, WarehouseExecutor>,
) {
	const tenant = yield* CurrentMcpTenant
	return yield* effect.pipe(provideWarehouseExecutorFromTenant(tenant))
})

export const queryWarehouse = Effect.fn("McpWarehouse.queryWarehouse")(function* <T = unknown>(
	pipe: WarehouseQueryName,
	params?: Record<string, unknown>,
) {
	const tenant = yield* CurrentMcpTenant
	const service = yield* WarehouseQueryService
	const response = yield* service
		.query(
			tenant,
			new WarehouseQueryRequest({ pipeName: pipe, ...(params === undefined ? undefined : { params }) }),
		)
		.pipe(Effect.mapError(toMcpQueryError(pipe)))

	return { data: response.data as T[] }
})
