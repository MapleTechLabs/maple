import type { Effect } from "effect"
import type {
	GcpMetricDescriptor,
	GcpMonitoredResourceType,
	GcpPromQlSeries,
} from "@maple/domain/gcp-live-metrics"
import type { GcpLiveQueryError } from "@maple/domain/http/gcp-live-query-errors"
import type { QueryTenant } from "./query-engine"

/**
 * Which projects a read covers. `projects` narrows it to those (from a `project_id` filter) when
 * the org's connections reach each directly; otherwise every project is read, and past 20 the
 * read is refused, except for `discovery` (the metrics list), which reads the first 20.
 * `requireComplete` fails the read when any project or connection fails, instead of answering
 * with the rest: an alert must not resolve on a project it could not read.
 */
export interface GcpReadScope {
	readonly projects?: ReadonlyArray<string> | undefined
	readonly requireComplete?: boolean | undefined
	readonly discovery?: boolean | undefined
}

/**
 * Google Cloud Monitoring, read live through its Prometheus-compatible API. The engine compiles a
 * metrics query on a Cloud Monitoring metric type (`isGcpMetricType`) to PromQL and runs it here,
 * once per project the org's metrics-on connections reach; each series carries its `project_id`.
 * Absent in deployments without a Google identity (local mode, the CLI); a Google metric then
 * fails as unavailable.
 */
export interface GcpLiveMetrics<T extends QueryTenant = QueryTenant> {
	/** Range query, times in epoch seconds. */
	readonly queryRange: (
		tenant: T,
		request: GcpReadScope & {
			readonly query: string
			readonly startSeconds: number
			readonly endSeconds: number
			readonly stepSeconds: number
		},
	) => Effect.Effect<ReadonlyArray<GcpPromQlSeries>, GcpLiveQueryError>
	/** Instant query at `timeSeconds`; each series carries one point. */
	readonly queryInstant: (
		tenant: T,
		request: GcpReadScope & { readonly query: string; readonly timeSeconds: number },
	) => Effect.Effect<ReadonlyArray<GcpPromQlSeries>, GcpLiveQueryError>
	/** Active metrics across the projects read (cached), resource types and labels merged per type. */
	readonly listMetrics: (
		tenant: T,
		request: GcpReadScope,
	) => Effect.Effect<ReadonlyArray<GcpMetricDescriptor>, GcpLiveQueryError>
	/** Google's monitored resource types with their label keys (cached a day). */
	readonly listResourceTypes: (
		tenant: T,
		request: GcpReadScope,
	) => Effect.Effect<ReadonlyArray<GcpMonitoredResourceType>, GcpLiveQueryError>
}
