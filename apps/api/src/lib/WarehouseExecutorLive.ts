import { Effect, Layer } from "effect"
import {
	WarehouseExecutor,
	ObservabilityError,
	type ExecutorQueryOptions,
} from "@maple/query-engine/observability"
import { WarehouseQueryService } from "./WarehouseQueryService"
import type { TenantContext } from "../services/AuthService"

/**
 * Creates a WarehouseExecutor layer that resolves the tenant from the current
 * HTTP request and delegates to WarehouseQueryService.
 *
 * Used by observability functions in @maple/query-engine/observability.
 * The executor name is preserved because it's a public contract from
 * @maple/query-engine — only the internal wiring changed.
 */
export const makeWarehouseExecutorFromTenant = (tenant: TenantContext) =>
	Layer.effect(
		WarehouseExecutor,
		Effect.gen(function* () {
			const warehouse = yield* WarehouseQueryService

			return WarehouseExecutor.of({
				orgId: tenant.orgId,
				query: <T>(pipe: string, params: Record<string, unknown>, options?: ExecutorQueryOptions) =>
					warehouse.query(tenant, { pipe: pipe as any, params }, options).pipe(
						Effect.map((response) => ({ data: response.data as unknown as ReadonlyArray<T> })),
						Effect.mapError(
							(error) =>
								new ObservabilityError({
									message: error.message,
									pipe,
									...("category" in error && error.category !== undefined
										? { category: error.category }
										: {}),
								}),
						),
						Effect.withSpan("WarehouseExecutor.query", {
							attributes: { pipe, orgId: tenant.orgId, "query.profile": options?.profile },
						}),
					),
				sqlQuery: <T>(sql: string, options?: ExecutorQueryOptions) =>
					warehouse
						.sqlQuery(tenant, sql, { ...options, context: "warehouseExecutor.sqlQuery" })
						.pipe(
							Effect.map((rows) => rows as unknown as ReadonlyArray<T>),
							Effect.mapError(
								(error) =>
									new ObservabilityError({
										message: error.message,
										...("category" in error && error.category !== undefined
											? { category: error.category }
											: {}),
									}),
							),
							Effect.withSpan("WarehouseExecutor.sqlQuery", {
								attributes: { orgId: tenant.orgId, "query.profile": options?.profile },
							}),
						),
			})
		}),
	)
