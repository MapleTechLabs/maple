import { Cause, Clock, DateTime, Effect } from "effect"
import { gcpMetricMapleType, type GcpMetricDescriptor } from "@maple/domain/gcp-live-metrics"
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

/** Whether a request's page can carry Google rows: only the first, and only for no service or Google's. */
const wantsGcpRows = (request: GcpMetricCatalogRequest) =>
	(request.offset ?? 0) === 0 &&
	(request.service === undefined || request.service === GCP_METRICS_SERVICE_NAME)

/** Active Google metrics as `listMetrics` rows, filtered like the warehouse query and capped at `limit`. */
const gcpMetricCatalogRows = (
	descriptors: ReadonlyArray<GcpMetricDescriptor>,
	request: GcpMetricCatalogRequest,
	nowMs: number,
): ReadonlyArray<GcpMetricCatalogRow> => {
	if (!wantsGcpRows(request)) return []
	const search = request.search?.toLowerCase()
	const lastSeen = DateTime.makeUnsafe(nowMs)
	const firstSeen = DateTime.makeUnsafe(nowMs - ACTIVE_WINDOW_MS)
	return descriptors
		.flatMap((descriptor) => {
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
}

/**
 * Google rows to append to a metrics list. Discovery never fails on Google: no connection is no
 * rows, any other failure is logged and is no rows.
 */
export const listGcpMetricCatalog = Effect.fn("QueryEngineService.listGcpMetrics")(function* (
	gcp: GcpLiveMetrics | undefined,
	tenant: QueryTenant,
	request: GcpMetricCatalogRequest,
) {
	if (gcp === undefined || !wantsGcpRows(request)) return []
	const descriptors = yield* gcp.listMetrics(tenant).pipe(
		Effect.catchTag("@maple/http/errors/GcpLiveQueryUnavailableError", () => Effect.succeed([])),
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.interrupt
				: Effect.logWarning("Google Cloud metrics left out of the metric list", cause).pipe(
						Effect.as([]),
					),
		),
	)
	return gcpMetricCatalogRows(descriptors, request, yield* Clock.currentTimeMillis)
})
