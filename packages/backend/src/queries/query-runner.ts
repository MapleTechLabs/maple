import {
	isTimeBucketQueryCachePolicy,
	queryDefinitionCacheIdentity,
	resolveQueryDefinitionCache,
	type QueryDefinition,
} from "@maple/query-engine/registry"
import {
	runQueryDefinition,
	runQueryDefinitionFirst,
	type QueryEngineDirectError,
} from "@maple/query-engine/runtime"
import { Clock, Effect, Option, Schema } from "effect"
import { baselineWarehouseCapabilities } from "@maple/query-engine"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import type { CompiledQueryRowSchema } from "@maple-dev/effect-orm/clickhouse"
import type { QueryEngineServiceApi } from "@maple/backend/services/warehouse/QueryEngineService"
import type { WarehouseQueryServiceApi } from "@maple/backend/services/warehouse/WarehouseQueryService"

/**
 * Applies registry cache and error policy. Services are values so the returned
 * effects have no requirements and can run inside `cachedDirect`.
 */
export interface QueryRunnerDeps {
	readonly warehouse: WarehouseQueryServiceApi
	readonly queryEngine: QueryEngineServiceApi
}

export const makeQueryRunners = ({ warehouse, queryEngine }: QueryRunnerDeps) => {
	const withPolicy = <Payload, Row, A, E extends QueryEngineDirectError>(
		def: QueryDefinition<Payload, Row>,
		tenant: TenantContext,
		payload: Payload,
		execute: Effect.Effect<A, E>,
		cacheCodec: (row: CompiledQueryRowSchema<Row>) => Schema.Codec<A, unknown, never, never>,
	) =>
		Effect.gen(function* () {
			// Static policies do not require a Clock service.
			const nowMs = typeof def.cache === "function" ? yield* Clock.currentTimeMillis : 0
			const cache = resolveQueryDefinitionCache(def, payload, nowMs)
			const labelled = execute.pipe(
				Effect.tapError(() =>
					Effect.annotateCurrentSpan({
						"maple.query_engine.failed_step": `${def.id} query failed`,
					}),
				),
			)
			if (cache === undefined || isTimeBucketQueryCachePolicy(cache)) {
				return yield* labelled
			}
			// Decoded rows hold values JSON cannot keep (a `DateTime.Utc` comes back as
			// a string), so the cache stores them through the query's own row codec.
			// A capability-aware plan may select differently, so it keeps plain JSON.
			const rowSchema = def.capabilityAware
				? undefined
				: yield* def.compile(payload, tenant.orgId, baselineWarehouseCapabilities()).pipe(
						Effect.map((compiled) => compiled.rowSchema),
						Effect.orElseSucceed(() => undefined),
					)
			return yield* queryEngine.cachedDirect(
				tenant,
				def.id,
				queryDefinitionCacheIdentity(def, payload),
				labelled,
				cache,
				rowSchema === undefined ? undefined : cacheCodec(rowSchema),
			)
		})

	const runQuery = <Payload, Row>(
		def: QueryDefinition<Payload, Row>,
		tenant: TenantContext,
		payload: Payload,
	) =>
		withPolicy(def, tenant, payload, runQueryDefinition(warehouse, def, tenant, payload), (row) =>
			Schema.Array(row),
		)

	const runQueryFirst = <Payload, Row>(
		def: QueryDefinition<Payload, Row>,
		tenant: TenantContext,
		payload: Payload,
	) =>
		withPolicy(
			def,
			tenant,
			payload,
			runQueryDefinitionFirst(warehouse, def, tenant, payload).pipe(Effect.map(Option.getOrNull)),
			(row) => Schema.NullOr(row),
		)

	return { runQuery, runQueryFirst } as const
}
