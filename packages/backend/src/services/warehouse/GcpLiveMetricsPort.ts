import { Context, Layer } from "effect"
import type { GcpLiveMetrics, QueryTenant } from "@maple/query-engine/runtime"
import { GcpLiveMetricsService } from "@maple/backend/services/integrations/GcpLiveMetricsService"

/**
 * Optional port `QueryEngineService` reads Cloud Monitoring metrics through. Deployments without
 * a Google identity leave it unprovided, and those metrics then fail as unavailable.
 */
export class GcpLiveMetricsPort extends Context.Service<GcpLiveMetricsPort, GcpLiveMetrics<QueryTenant>>()(
	"@maple/backend/services/warehouse/GcpLiveMetricsPort",
) {
	/** Backed by `GcpLiveMetricsService`. Provide it where `QueryEngineService.layer` is built. */
	static readonly layer = Layer.effect(this, GcpLiveMetricsService).pipe(
		Layer.provide(GcpLiveMetricsService.layer),
	)
}
