/** Shared warehouse dependencies, without management or integration services. */
import { BucketCacheService } from "@maple/query-engine/caching"
import { Layer } from "effect"
import { EdgeCacheServiceLive } from "@/platform/CacheBackendLive"
import { Env } from "@/platform/Env"
import { AuditLogService } from "@/services/audit/AuditLogService"
import { OrgClickHouseSettingsService } from "@/services/org/OrgClickHouseSettingsService"
import { TinybirdOrgTokenService } from "@/services/integrations/TinybirdOrgTokenService"
import { QueryEngineService } from "@/services/warehouse/QueryEngineService"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"

export const OrgClickHouseSettingsLive = OrgClickHouseSettingsService.layer.pipe(
	Layer.provide(EdgeCacheServiceLive),
)
export const WarehouseQueryServiceLive = WarehouseQueryService.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(OrgClickHouseSettingsLive, TinybirdOrgTokenService.layer)),
	Layer.provideMerge(Env.layer),
)
const BucketCacheServiceLive = BucketCacheService.layer.pipe(Layer.provideMerge(EdgeCacheServiceLive))
export const QueryEngineServiceLive = QueryEngineService.layer.pipe(
	Layer.provideMerge(WarehouseQueryServiceLive),
	Layer.provideMerge(EdgeCacheServiceLive),
	Layer.provideMerge(BucketCacheServiceLive),
)
export const AuditLogServiceLive = AuditLogService.layer.pipe(Layer.provide(WarehouseQueryServiceLive))
