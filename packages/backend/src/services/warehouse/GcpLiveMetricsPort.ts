import { Context } from "effect"
import type { GcpLiveMetrics, QueryTenant } from "@maple/query-engine/runtime"

/**
 * Optional port `QueryEngineService` reads Cloud Monitoring metrics through. Deployments without
 * a Google identity leave it unprovided, and those metrics then fail as unavailable.
 */
export class GcpLiveMetricsPort extends Context.Service<GcpLiveMetricsPort, GcpLiveMetrics<QueryTenant>>()(
	"@maple/backend/services/warehouse/GcpLiveMetricsPort",
) {}
