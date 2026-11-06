import { CacheBackend, EdgeCacheService, makeMemoryBackend, type EdgeCacheBackend } from "@maple/cache"
import { Effect, Layer, Ref } from "effect"
import type { OrgId } from "@maple/domain/http"
import {
	ORG_CH_CONFIG_CACHE_BUCKET,
	OrgClickHouseSettingsService,
} from "../services/org/OrgClickHouseSettingsService"
import {
	WarehouseQueryService,
	type WarehouseQueryServiceApi,
} from "../services/warehouse/WarehouseQueryService"

/**
 * Counts cold org warehouse-config resolutions: each one is an edge-cache
 * compute (a Postgres point read) that ends in a put to the org-config bucket.
 */
export const makeOrgConfigProbe = Effect.gen(function* () {
	const computes = yield* Ref.make(0)
	const inner = makeMemoryBackend()
	const backend: EdgeCacheBackend = {
		...inner,
		put: (bucket, hash, value, ttlSeconds, nowMs) =>
			Effect.andThen(
				bucket === ORG_CH_CONFIG_CACHE_BUCKET ? Ref.update(computes, (n) => n + 1) : Effect.void,
				inner.put(bucket, hash, value, ttlSeconds, nowMs),
			),
	}
	const edgeCacheLive = EdgeCacheService.layer.pipe(Layer.provide(Layer.succeed(CacheBackend, backend)))
	// The real settings service, reading through the counting cache.
	const orgChSettingsLive = OrgClickHouseSettingsService.layer.pipe(Layer.provide(edgeCacheLive))
	return { backend, edgeCacheLive, orgChSettingsLive, coldReads: Ref.get(computes) }
})

/**
 * Builds a warehouse stub whose routed calls can first resolve the tenant's
 * runtime config, as `WarehouseQueryService` does when it picks a route.
 */
export const configResolvingWarehouse = (
	make: (resolveConfig: (orgId: OrgId) => Effect.Effect<void>) => WarehouseQueryServiceApi,
): Layer.Layer<WarehouseQueryService, never, OrgClickHouseSettingsService> =>
	Layer.effect(
		WarehouseQueryService,
		Effect.gen(function* () {
			const settings = yield* OrgClickHouseSettingsService
			return make((orgId) => settings.resolveRuntimeConfig(orgId).pipe(Effect.orDie, Effect.asVoid))
		}),
	)
