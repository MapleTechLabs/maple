import { Layer } from "effect"
import { EdgeCacheServiceLive } from "@/platform/CacheBackendLive"
import { AuditLogService } from "@/services/audit/AuditLogService"
import { TinybirdOrgTokenService } from "@/services/integrations/TinybirdOrgTokenService"
import { OrgClickHouseSettingsService } from "@/services/org/OrgClickHouseSettingsService"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"

/**
 * The warehouse for the headless graphs (MCP, the queue consumers): the query
 * service over the org's ClickHouse settings and the per-org token minter.
 * Requires `Env` and `Database` from the caller's base layer; the HTTP graph
 * composes its own over `CoreServicesLive`.
 */
export const OrgClickHouseSettingsLive = OrgClickHouseSettingsService.layer.pipe(
	Layer.provide(EdgeCacheServiceLive),
)

export const WarehouseLive = WarehouseQueryService.layer.pipe(
	Layer.provide(Layer.mergeAll(OrgClickHouseSettingsLive, TinybirdOrgTokenService.layer)),
)

/** Audit entries are warehouse rows, so the service composes after the warehouse. */
export const AuditLogLive = AuditLogService.layer.pipe(Layer.provide(WarehouseLive))
