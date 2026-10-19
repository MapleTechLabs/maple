import type { Effect } from "effect"
import type { GcpMetricDescriptor, GcpPromQlSeries } from "@maple/domain/gcp-live-metrics"
import type { GcpLiveQueryError } from "@maple/domain/http/gcp-live-query-errors"
import type { QueryTenant } from "./query-engine"

/**
 * Google Cloud Monitoring, read live through its Prometheus-compatible API. The engine compiles a
 * metrics query on a Cloud Monitoring metric type (`isGcpMetricType`) to PromQL and runs it here,
 * across every project the org's metrics-on connections reach. Absent in deployments without a
 * Google identity (local mode, the CLI); a Google metric then fails as unavailable.
 */
export interface GcpLiveMetrics<T extends QueryTenant = QueryTenant> {
	/** Range query, times in epoch seconds. `projects` narrows the fan-out (from a `project_id` filter). */
	readonly queryRange: (
		tenant: T,
		request: {
			readonly query: string
			readonly startSeconds: number
			readonly endSeconds: number
			readonly stepSeconds: number
			readonly projects?: ReadonlyArray<string>
		},
	) => Effect.Effect<ReadonlyArray<GcpPromQlSeries>, GcpLiveQueryError>
	/** Instant query at `timeSeconds`; each series carries one point. */
	readonly queryInstant: (
		tenant: T,
		request: {
			readonly query: string
			readonly timeSeconds: number
			readonly projects?: ReadonlyArray<string>
		},
	) => Effect.Effect<ReadonlyArray<GcpPromQlSeries>, GcpLiveQueryError>
	/** Active metrics across the org's projects (cached). */
	readonly listMetrics: (tenant: T) => Effect.Effect<ReadonlyArray<GcpMetricDescriptor>, GcpLiveQueryError>
	/** One active metric, its resource types merged across projects; undefined when no project reports it. */
	readonly describeMetric: (
		tenant: T,
		metricType: string,
	) => Effect.Effect<GcpMetricDescriptor | undefined, GcpLiveQueryError>
}
