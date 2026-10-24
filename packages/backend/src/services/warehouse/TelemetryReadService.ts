// Direct warehouse reads behind the public telemetry endpoints (`/v2/traces`,
// `/v2/logs`, `/v2/metrics`, `/v2/services`, `/v2/service_map`,
// `/v2/environments`, `/v2/widget_summary`). Routes validate the caller's window
// and shape the wire model; this owns the queries, their profiles and contexts.
// Aggregations that go through the query engine stay on `QueryEngineService`.

import { Context, Effect, Layer, Schema } from "effect"
import {
	ServiceHealthBaselineRequest,
	ServiceHealthSnapshotRequest,
	ServiceOperationsRequest,
} from "@maple/domain/http"
import {
	CH,
	formatWarehouseDateTime,
	formatWarehouseDateTimeMs,
	parseWarehouseDateTime,
} from "@maple/query-engine"
import { LOGS_BODY_SEARCH_SETTINGS } from "@maple/query-engine/profiles"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import { makeDashboardReads, operationsSparklineBucketSeconds } from "@maple/backend/queries/dashboard-reads"

/** A validated window in warehouse literal form, at the precision of the table read. */
export interface TelemetryWindow {
	readonly startTime: string
	readonly endTime: string
}

const HOUR_MS = 60 * 60 * 1000
const PARTITION_HINT_RADIUS_MS = HOUR_MS
// The latency baseline covers the seven days BEFORE the window being judged,
// so a regression that is still running can't raise the bar it is measured against.
const BASELINE_WINDOW_MS = 7 * 24 * HOUR_MS

/**
 * The trailing p95 a service is judged against, keyed by service name. The
 * catalog rows aggregate every namespace and environment under one name, so
 * the baseline rows collapse the same way: the busiest row wins rather than
 * the numbers being averaged across populations that don't compare.
 */
export type ServiceBaselines = ReadonlyMap<string, { p95LatencyMs: number; spanCount: number }>

const collapseBaselines = (
	rows: ReadonlyArray<{ serviceName: string; baselineP95LatencyMs: number; baselineSpanCount: number }>,
): ServiceBaselines =>
	rows.reduce((map, row) => {
		const current = map.get(row.serviceName)
		if (current !== undefined && current.spanCount >= row.baselineSpanCount) return map
		return map.set(row.serviceName, {
			p95LatencyMs: row.baselineP95LatencyMs,
			spanCount: row.baselineSpanCount,
		})
	}, new Map<string, { p95LatencyMs: number; spanCount: number }>())

const make = Effect.gen(function* () {
	const warehouse = yield* WarehouseQueryService
	const queryEngine = yield* QueryEngineService
	const reads = makeDashboardReads({ warehouse, queryEngine })

	const searchTraces = Effect.fn("TelemetryReadService.searchTraces")(function* (
		tenant: TenantContext,
		opts: CH.TraceSummariesOpts,
		window: TelemetryWindow,
	) {
		const compiled = CH.compile(CH.traceSummariesQuery(opts), { orgId: tenant.orgId, ...window })
		return yield* warehouse.compiledQuery(tenant, compiled, { profile: "list", context: "v2TraceSearch" })
	})

	/**
	 * Every span of a trace, through the dashboard's own read: a probe bounds it to the trace's
	 * partitions and the result is edge-cached under the dashboard's key.
	 */
	const traceSpans = Effect.fn("TelemetryReadService.traceSpans")(function* (
		tenant: TenantContext,
		traceId: string,
	) {
		return yield* reads.spanHierarchy(tenant, { traceId })
	})

	const span = Effect.fn("TelemetryReadService.span")(function* (
		tenant: TenantContext,
		traceId: string,
		spanId: string,
	) {
		const compiled = CH.compile(CH.spanDetailQuery({ traceId, spanId }), { orgId: tenant.orgId })
		return yield* warehouse.compiledQueryFirst(tenant, compiled, {
			profile: "discovery",
			context: "v2GetSpan",
		})
	})

	const searchLogs = Effect.fn("TelemetryReadService.searchLogs")(function* (
		tenant: TenantContext,
		opts: CH.LogsListOpts,
		window: TelemetryWindow,
	) {
		const compiled = CH.compile(CH.logsListQuery(opts), { orgId: tenant.orgId, ...window })
		return yield* warehouse.compiledQuery(tenant, compiled, {
			profile: "list",
			context: "v2LogSearch",
			settings: opts.search ? LOGS_BODY_SEARCH_SETTINGS : undefined,
		})
	})

	/** One log by its exact timestamp and record identity, read from the partitions around it. */
	const log = Effect.fn("TelemetryReadService.log")(function* (
		tenant: TenantContext,
		key: { readonly timestamp: string; readonly recordIdentity: string },
	) {
		const ms = parseWarehouseDateTime(key.timestamp)
		const compiled = CH.compile(CH.getLogByKeyQuery({ recordIdentity: key.recordIdentity }), {
			orgId: tenant.orgId,
			startTime: formatWarehouseDateTimeMs(ms - PARTITION_HINT_RADIUS_MS),
			endTime: formatWarehouseDateTimeMs(ms + PARTITION_HINT_RADIUS_MS),
			timestamp: key.timestamp,
		})
		return yield* warehouse.compiledQueryFirst(tenant, compiled, { profile: "list", context: "v2GetLog" })
	})

	const listMetrics = Effect.fn("TelemetryReadService.listMetrics")(function* (
		tenant: TenantContext,
		opts: CH.ListMetricsOpts,
		window: TelemetryWindow,
	) {
		const compiled = CH.compile(CH.listMetricsQuery(opts), { orgId: tenant.orgId, ...window })
		return yield* warehouse.compiledQuery(tenant, compiled, {
			profile: "discovery",
			context: "v2ListMetrics",
		})
	})

	/**
	 * Trailing p95 per (service, namespace, environment) for the seven days before `windowStartMs`,
	 * through the dashboard's baseline definition and cache key. Degrades to no rows on failure.
	 */
	const serviceBaselineRows = (
		tenant: TenantContext,
		windowStartMs: number,
		filters: { readonly deploymentEnvironment?: string; readonly serviceNamespace?: string },
	) =>
		Effect.gen(function* () {
			// Hour-floored, like the dashboard's, so a drifting client window keeps one cache entry.
			const endMs = Math.floor(windowStartMs / HOUR_MS) * HOUR_MS
			const request = yield* Schema.decodeUnknownEffect(ServiceHealthBaselineRequest)({
				startTime: formatWarehouseDateTime(endMs - BASELINE_WINDOW_MS),
				endTime: formatWarehouseDateTime(endMs),
				environments: filters.deploymentEnvironment ? [filters.deploymentEnvironment] : undefined,
				namespaces: filters.serviceNamespace ? [filters.serviceNamespace] : undefined,
			}).pipe(Effect.orDie)
			return yield* reads.serviceHealthBaseline(tenant, request)
		}).pipe(
			Effect.catchCause((cause) =>
				Effect.as(
					Effect.logWarning("v2 service baseline read failed", cause),
					[] as ReadonlyArray<CH.ServiceHealthBaselineOutput>,
				),
			),
		)

	/** The baseline rows collapsed by service name, as the catalog rows are. */
	const serviceBaselines = (
		tenant: TenantContext,
		windowStartMs: number,
		filters: { readonly deploymentEnvironment?: string; readonly serviceNamespace?: string },
	) => Effect.map(serviceBaselineRows(tenant, windowStartMs, filters), collapseBaselines)

	const serviceCatalog = Effect.fn("TelemetryReadService.serviceCatalog")(function* (
		tenant: TenantContext,
		opts: CH.ServiceCatalogOpts,
		window: TelemetryWindow,
		context: "v2ServiceCatalog" | "v2WidgetSummaryServices" = "v2ServiceCatalog",
	) {
		const compiled = CH.compile(CH.serviceCatalogQuery(opts), { orgId: tenant.orgId, ...window })
		return yield* warehouse.compiledQuery(tenant, compiled, { profile: "aggregation", context })
	})

	/**
	 * A service's busiest operations, through the dashboard's 30s Operations entry (same payload,
	 * sparkline bucket included). A plain function, so fallbacks label the route's own span.
	 */
	const serviceOperations = (
		tenant: TenantContext,
		opts: {
			readonly serviceName: string
			readonly environments?: ReadonlyArray<string> | undefined
			readonly limit: number
		},
		window: TelemetryWindow,
	) =>
		Effect.gen(function* () {
			// Built from a window the route already validated, so a decode failure is a defect.
			const request = yield* Schema.decodeUnknownEffect(ServiceOperationsRequest)({
				serviceName: opts.serviceName,
				startTime: window.startTime,
				endTime: window.endTime,
				environments: opts.environments,
				bucketSeconds: operationsSparklineBucketSeconds(window.startTime, window.endTime),
				limit: opts.limit,
			}).pipe(Effect.orDie)
			// The sparklines are only what buys the shared entry; their failure must not cost the rows.
			return yield* reads
				.serviceOperations(tenant, request)
				.pipe(
					Effect.catch((error) =>
						Effect.logWarning("Shared operations read failed; reading the summary alone").pipe(
							Effect.annotateLogs({ orgId: tenant.orgId, error: error.message }),
							Effect.andThen(reads.serviceOperationsSummary(tenant, request)),
						),
					),
				)
		})

	/** Golden signals per (service, environment) from the hourly aggregate, as the overview reads them. */
	const serviceHealthSnapshot = Effect.fn("TelemetryReadService.serviceHealthSnapshot")(function* (
		tenant: TenantContext,
		opts: { readonly environments?: ReadonlyArray<string> | undefined },
		window: TelemetryWindow,
	) {
		const request = yield* Schema.decodeUnknownEffect(ServiceHealthSnapshotRequest)({
			startTime: window.startTime,
			endTime: window.endTime,
			environments: opts.environments,
		}).pipe(Effect.orDie)
		return yield* reads.serviceHealthSnapshot(tenant, request)
	})

	/**
	 * The deployment environments seen in the window. `"discovery"` rather than
	 * `"aggregation"`: a `GROUP BY` over one LowCardinality column that clients
	 * poll to keep a picker populated should not spend an analytical budget.
	 */
	const environments = Effect.fn("TelemetryReadService.environments")(function* (
		tenant: TenantContext,
		window: TelemetryWindow,
	) {
		const compiled = CH.compile(CH.serviceEnvironmentsQuery(), { orgId: tenant.orgId, ...window })
		return yield* warehouse.compiledQuery(tenant, compiled, {
			profile: "discovery",
			context: "v2Environments",
		})
	})

	const serviceMap = Effect.fn("TelemetryReadService.serviceMap")(function* (
		tenant: TenantContext,
		opts: { readonly serviceName?: string; readonly deploymentEnv?: string },
		window: TelemetryWindow,
	) {
		const params = { orgId: tenant.orgId, ...window }
		const compiled = opts.serviceName
			? CH.compile(
					CH.serviceDependenciesForServiceQuery({
						serviceName: opts.serviceName,
						deploymentEnv: opts.deploymentEnv,
					}),
					params,
				)
			: CH.serviceDependenciesSQL({ deploymentEnv: opts.deploymentEnv }, params)
		return yield* warehouse.compiledQuery(tenant, compiled, {
			profile: "aggregation",
			context: "v2ServiceMap",
		})
	})

	return {
		searchTraces,
		traceSpans,
		span,
		searchLogs,
		log,
		listMetrics,
		serviceBaselineRows,
		serviceBaselines,
		serviceCatalog,
		serviceOperations,
		serviceHealthSnapshot,
		environments,
		serviceMap,
	}
})

export class TelemetryReadService extends Context.Service<TelemetryReadService>()(
	"@maple/backend/services/TelemetryReadService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(WarehouseQueryService.layer, QueryEngineService.layer)),
	)
}
