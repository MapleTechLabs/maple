// Direct warehouse reads behind the public telemetry endpoints (`/v2/traces`,
// `/v2/logs`, `/v2/metrics`, `/v2/services`, `/v2/service_map`,
// `/v2/environments`, `/v2/widget_summary`). Routes validate the caller's window
// and shape the wire model; this owns the queries, their profiles and contexts.
// Aggregations that go through the query engine stay on `QueryEngineService`.

import { Context, Effect, Layer } from "effect"
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
import { isMissingServiceOperationsRollup } from "@maple/backend/services/warehouse/missing-table"

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
// Matches the `serviceHealthBaseline` registry definition the dashboard reads
// through, so both surfaces re-read a week-wide aggregate at the same rate.
const BASELINE_CACHE_SECONDS = 3600

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

	const searchTraces = Effect.fn("TelemetryReadService.searchTraces")(function* (
		tenant: TenantContext,
		opts: CH.TraceSummariesOpts,
		window: TelemetryWindow,
	) {
		const compiled = CH.compile(CH.traceSummariesQuery(opts), { orgId: tenant.orgId, ...window })
		return yield* warehouse.compiledQuery(tenant, compiled, { profile: "list", context: "v2TraceSearch" })
	})

	/** Up to `SPAN_HIERARCHY_MAX_SPANS + 1` spans, so a caller can tell a truncated trace. */
	const traceSpans = Effect.fn("TelemetryReadService.traceSpans")(function* (
		tenant: TenantContext,
		traceId: string,
	) {
		const compiled = CH.compile(
			CH.spanHierarchyQuery({ traceId, limit: CH.SPAN_HIERARCHY_MAX_SPANS + 1 }),
			{
				orgId: tenant.orgId,
			},
		)
		return yield* warehouse.compiledQuery(tenant, compiled, { profile: "list", context: "v2GetTrace" })
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
	 * Trailing p95 per service for the seven days before `windowStartMs`.
	 *
	 * Hour-floored so a polling client's drifting window keeps hitting the same
	 * cache entry, and cached for an hour. A missing baseline is a supported
	 * state (clients fall back to absolute thresholds), so a failed read degrades
	 * to no baselines instead of failing the caller.
	 */
	const serviceBaselines = (
		tenant: TenantContext,
		windowStartMs: number,
		filters: { readonly deploymentEnvironment?: string; readonly serviceNamespace?: string },
	) =>
		Effect.gen(function* () {
			const endMs = Math.floor(windowStartMs / HOUR_MS) * HOUR_MS
			const window = {
				startTime: formatWarehouseDateTime(endMs - BASELINE_WINDOW_MS),
				endTime: formatWarehouseDateTime(endMs),
			}
			const compiled = CH.compile(
				CH.serviceHealthBaselineQuery({
					environments: filters.deploymentEnvironment ? [filters.deploymentEnvironment] : undefined,
					namespaces: filters.serviceNamespace ? [filters.serviceNamespace] : undefined,
				}),
				{ orgId: tenant.orgId, ...window },
			)
			const rows = yield* queryEngine.cachedDirect(
				tenant,
				"v2ServiceHealthBaseline",
				{ ...window, ...filters },
				warehouse.compiledQuery(tenant, compiled, {
					profile: "aggregation",
					context: "v2ServiceHealthBaseline",
				}),
				BASELINE_CACHE_SECONDS,
			)
			return collapseBaselines(rows)
		}).pipe(
			Effect.catchCause((cause) =>
				Effect.as(Effect.logWarning("v2 service baseline read failed", cause), collapseBaselines([])),
			),
		)

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
	 * Per-operation summary for one service. Same rollout state as the internal
	 * Operations tab: the `service_operations_*` rollups reach a BYO cluster only
	 * when its admin applies schema, so a missing table reads raw traces instead.
	 */
	const serviceOperations = (
		tenant: TenantContext,
		opts: CH.ServiceOperationsSummaryOpts,
		window: TelemetryWindow,
	) => {
		const params = { orgId: tenant.orgId, ...window }
		const rowSchema = { rowSchema: CH.serviceOperationsSummaryRowSchema }
		const run = (rollup: boolean) =>
			warehouse.compiledQuery(
				tenant,
				rollup
					? CH.compile(CH.serviceOperationsSummaryQuery(opts), params, rowSchema)
					: CH.compile(CH.serviceOperationsSummaryRawQuery(opts), params, rowSchema),
				{
					profile: "aggregation",
					context: rollup ? "v2ServiceOverviewOperations" : "v2ServiceOverviewOperationsRaw",
				},
			)
		return run(true).pipe(
			Effect.catch((error) =>
				isMissingServiceOperationsRollup(error)
					? Effect.logWarning(
							"service_operations rollup is absent on this cluster; reading raw traces for the v2 service overview.",
						).pipe(Effect.annotateLogs({ orgId: tenant.orgId }), Effect.andThen(run(false)))
					: Effect.fail(error),
			),
		)
	}

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
		serviceBaselines,
		serviceCatalog,
		serviceOperations,
		environments,
		serviceMap,
	}
})

export class TelemetryReadService extends Context.Service<TelemetryReadService>()(
	"@maple/api/services/TelemetryReadService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(WarehouseQueryService.layer, QueryEngineService.layer)),
	)
}
