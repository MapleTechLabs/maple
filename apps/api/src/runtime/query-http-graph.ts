import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { EdgeCacheServiceLive } from "@maple/backend/platform/CacheBackendLive"
/** The dashboard read path acquires only its warehouse, auth, and audit dependencies. */
import { MapleInternalApi } from "@maple/domain/http"
import { Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { API_CORS_OPTIONS } from "@maple/backend/http/api-cors"
import { Env } from "@maple/backend/platform/Env"
import { HttpQueryEngineLive } from "@/routes/internal/query-engine.http"
import { V1ErrorBoundaryLive } from "@maple/backend/http/error-boundary"
import { NotFoundRouter } from "@/routes/discovery.http"
import { SessionAuthorizationLayer } from "@maple/backend/services/auth/SessionAuthorizationLayer"
import { OrganizationRegionService } from "@maple/backend/services/org/OrganizationRegionService"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"

// Select the already-decorated group: its session auth and v1 error middleware
// are exactly those of the complete internal API. The service key keeps the API id.
const QueryApi = HttpApi.make("MapleInternalApi").add(MapleInternalApi.groups.queryEngine)
export const QueryRoutes = Layer.mergeAll(
	HttpApiBuilder.layer(QueryApi).pipe(
		Layer.provide(HttpQueryEngineLive),
		Layer.provide(V1ErrorBoundaryLive),
	),
	// Raw route registration is a side effect on this router, not a shared service.
	Layer.fresh(NotFoundRouter),
).pipe(
	Layer.provideMerge(HttpRouter.cors(API_CORS_OPTIONS)),
	Layer.provideMerge(SessionAuthorizationLayer),
	// `provideMerge`, not `provide`: the raw-SQL handler records its own audit
	// entry, and a handler's requirement is a phantom `Request<"Requires">`
	// marker the build cannot refuse. Hidden behind the auth layer, the service
	// was missing from every handler this graph built first, and
	// `execute-raw-sql` answered 500 "Service not found" for that isolate's life.
	Layer.provideMerge(
		Layer.mergeAll(
			QueryEngineService.layer,
			WarehouseQueryService.layer,
			AuditLogService.layer,
			OrganizationRegionService.layer,
		),
	),
	Layer.provide(Layer.mergeAll(Env.layer, EdgeCacheServiceLive)),
)
