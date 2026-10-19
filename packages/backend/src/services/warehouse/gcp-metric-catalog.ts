import { Clock, DateTime, Effect } from "effect"
import { gcpMetricMapleType } from "@maple/domain/gcp-live-metrics"
import type { ListMetricsOutput } from "@maple/query-engine/ch"
import type { GcpLiveMetrics, QueryTenant } from "@maple/query-engine/runtime"

/** The service name Google Cloud metrics list under. */
const GCP_METRICS_SERVICE_NAME = "Google Cloud"

/** Google lists a metric when it has data in the last ~25 hours. */
const ACTIVE_WINDOW_MS = 25 * 3_600_000

/** A `listMetrics` row. `Pick` makes it a plain object type, which passes as a wire row; the interface does not. */
export type GcpMetricCatalogRow = Pick<ListMetricsOutput, keyof ListMetricsOutput>

/** The `listMetrics` filters Google rows answer. */
export interface GcpMetricCatalogRequest {
	readonly service?: string | undefined
	readonly metricType?: string | undefined
	readonly search?: string | undefined
	readonly limit?: number | undefined
	readonly offset?: number | undefined
}

/**
 * Active Google metrics as `listMetrics` rows to append to a metrics list, filtered like the
 * warehouse query and capped at `limit`. Only the first page carries them, and only for no
 * service or Google's. Discovery never fails on Google: a failure (logged where it happens) is
 * no rows.
 */
export const listGcpMetricCatalog = Effect.fn("QueryEngineService.listGcpMetrics")(function* (
	gcp: GcpLiveMetrics,
	tenant: QueryTenant,
	request: GcpMetricCatalogRequest,
) {
	if ((request.offset ?? 0) !== 0) return []
	if (request.service !== undefined && request.service !== GCP_METRICS_SERVICE_NAME) return []
	// Typed failures only: a defect is a bug, not Google being unavailable.
	const descriptors = yield* gcp
		.listMetrics(tenant, { discovery: true })
		.pipe(Effect.orElseSucceed(() => []))
	const nowMs = yield* Clock.currentTimeMillis
	const search = request.search?.toLowerCase()
	const lastSeen = DateTime.makeUnsafe(nowMs)
	const firstSeen = DateTime.makeUnsafe(nowMs - ACTIVE_WINDOW_MS)
	return descriptors
		.flatMap((descriptor): ReadonlyArray<GcpMetricCatalogRow> => {
			const metricType = gcpMetricMapleType(descriptor)
			if (metricType === undefined) return []
			if (request.metricType !== undefined && metricType !== request.metricType) return []
			if (search !== undefined && !descriptor.type.toLowerCase().includes(search)) return []
			return [
				{
					metricName: descriptor.type,
					metricType,
					serviceName: GCP_METRICS_SERVICE_NAME,
					metricDescription: descriptor.description,
					metricUnit: descriptor.unit,
					dataPointCount: 0,
					firstSeen,
					lastSeen,
					// The warehouse column's encoding, which callers compare against 0.
					isMonotonic: descriptor.metricKind === "GAUGE" ? 0 : 1,
				},
			]
		})
		.slice(0, request.limit ?? 100)
})
