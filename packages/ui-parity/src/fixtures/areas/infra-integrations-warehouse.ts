import { DateTime, Effect, Schema } from "effect"
import { CH } from "@maple/query-engine"
import {
	CloudflareInfraPlatformResourcesRequest,
	CloudflareInfraPlatformResourcesResponse,
	CloudflareInfraWorkerDetailRequest,
	CloudflareInfraWorkerDetailResponse,
	CloudflareInfraWorkersRequest,
	CloudflareInfraWorkersResponse,
	CloudflareInfraZoneBreakdownRequest,
	CloudflareInfraZoneBreakdownResponse,
	CloudflareInfraZoneDetailRequest,
	CloudflareInfraZoneDetailResponse,
	CloudflareInfraZoneDnsRequest,
	CloudflareInfraZoneDnsResponse,
	CloudflareInfraZoneFacetsRequest,
	CloudflareInfraZoneFacetsResponse,
	CloudflareInfraZoneSecurityRequest,
	CloudflareInfraZoneSecurityResponse,
	CloudflareInfraZoneTimeseriesRequest,
	CloudflareInfraZoneTimeseriesResponse,
	CloudflareInfraZonesRequest,
	CloudflareInfraZonesResponse,
	GcpCloudSqlDatabasesResponse,
	GcpCloudSqlInstanceRequest,
	GcpCloudSqlTopQueriesResponse,
	GcpInfraMetricsRequest,
	GcpInfraMetricsResponse,
	GcpInfraPresenceRequest,
	GcpInfraPresenceResponse,
	GcpInfraSparklinesRequest,
	GcpInfraSparklinesResponse,
	GcpInfraTimeseriesRequest,
	GcpInfraTimeseriesResponse,
	PlanetScaleInfraTimeseriesRequest,
	PlanetScaleInfraTimeseriesResponse,
	RailwayInfraRowsResponse,
	RailwayInfraServicesRequest,
	RailwayInfraServiceTimeseriesRequest,
	ReleasesListRequest,
	ReleasesListResponse,
	ServiceDbQuerySummaryRequest,
	ServiceDbQuerySummaryResponse,
	ServiceCloudflareStatsRequest,
	ServiceCloudflareStatsResponse,
	ServicePlanetScaleStatsRequest,
	ServicePlanetScaleStatsResponse,
} from "@maple/domain/http"
import { GCP_INFRA_SERVICE_IDS, gcpInfraMetrics } from "@maple/domain/gcp-infra"
import { toCloudflareFilters } from "@maple/backend/queries/query-helpers"
import * as Integrations from "@maple/query-engine-integrations"
import { Queries } from "../../../../../apps/api/src/routes/queries.ts"
import { warehouseEndpoint } from "../../backend/endpoints/run.ts"
import type { FixtureWarehouse } from "../../backend/warehouse.ts"
import type { EndpointHandler } from "../dataset.ts"

/**
 * The integration reads of `apps/api/src/routes/internal/query-engine.http.ts`, mirrored handler
 * by handler over the API's own query registry (`apps/api/src/routes/queries.ts`).
 */

const cloudflareEndpoints = (warehouse: FixtureWarehouse): Readonly<Record<string, EndpointHandler>> => ({
	"queryEngine.cloudflareInfraZones": warehouseEndpoint(
		warehouse,
		CloudflareInfraZonesRequest,
		CloudflareInfraZonesResponse,
		(payload, { runQuery }) =>
			Effect.gen(function* () {
				const [counterRows, latencyRows] = yield* Effect.all([
					runQuery(Queries.cloudflareInfraZoneCounters, payload),
					runQuery(Queries.cloudflareInfraZoneLatency, payload),
				])
				const latencyByService = new Map(latencyRows.map((row) => [row.serviceName, row]))
				const data = counterRows.map((row) => {
					const latency = latencyByService.get(row.serviceName)
					return {
						serviceName: row.serviceName,
						requests: row.requests,
						errors5xx: row.errors5xx,
						errors4xx: row.errors4xx,
						requests2xx: row.requests2xx,
						requests3xx: row.requests3xx,
						cacheHits: row.cacheHits,
						cacheableRequests: row.cacheableRequests,
						bytes: row.bytes,
						visits: row.visits,
						ttfbP50Ms: latency?.ttfbP50Ms ?? 0,
						ttfbP95Ms: latency?.ttfbP95Ms ?? 0,
						ttfbP99Ms: latency?.ttfbP99Ms ?? 0,
						originP50Ms: latency?.originP50Ms ?? 0,
						originP95Ms: latency?.originP95Ms ?? 0,
						originP99Ms: latency?.originP99Ms ?? 0,
					}
				})
				return new CloudflareInfraZonesResponse({
					data,
					ignoredFilters: Integrations.cloudflareIgnoredFiltersFor(toCloudflareFilters(payload), [
						Integrations.CF_METRIC.requests,
						Integrations.CF_METRIC.bytes,
						Integrations.CF_METRIC.visits,
					]),
				})
			}),
	),
	"queryEngine.cloudflareInfraZoneTimeseries": warehouseEndpoint(
		warehouse,
		CloudflareInfraZoneTimeseriesRequest,
		CloudflareInfraZoneTimeseriesResponse,
		(payload, { runQuery }) =>
			Effect.map(
				runQuery(Queries.cloudflareInfraZoneTimeseries, payload),
				(rows) =>
					new CloudflareInfraZoneTimeseriesResponse({
						data: rows.map((row) => ({ ...row })),
						ignoredFilters: Integrations.cloudflareIgnoredFiltersFor(
							toCloudflareFilters(payload),
							[Integrations.CF_METRIC.requests],
						),
					}),
			),
	),
	"queryEngine.cloudflareInfraZoneDetail": warehouseEndpoint(
		warehouse,
		CloudflareInfraZoneDetailRequest,
		CloudflareInfraZoneDetailResponse,
		(payload, { runQuery }) =>
			Effect.gen(function* () {
				const filters = toCloudflareFilters(payload)
				const [statusRows, cacheRows, latencyRows] = yield* Effect.all([
					runQuery(Queries.cloudflareInfraZoneDetailStatus, payload),
					runQuery(Queries.cloudflareInfraZoneDetailCache, payload),
					runQuery(Queries.cloudflareInfraZoneDetailLatency, payload),
				])
				return new CloudflareInfraZoneDetailResponse({
					statusBuckets: statusRows.map((row) => ({ ...row })),
					cacheBuckets: cacheRows.map((row) => ({ ...row })),
					latencyBuckets: latencyRows.map((row) => ({ ...row })),
					ignoredFilters: Integrations.cloudflareIgnoredFiltersFor(filters, [
						Integrations.CF_METRIC.requests,
					]),
					latencyIgnoredFilters: Integrations.cloudflareIgnoredFiltersFor(filters, [
						Integrations.CF_METRIC.edgeTtfb,
						Integrations.CF_METRIC.originDuration,
					]),
				})
			}),
	),
	"queryEngine.cloudflareInfraWorkerDetail": warehouseEndpoint(
		warehouse,
		CloudflareInfraWorkerDetailRequest,
		CloudflareInfraWorkerDetailResponse,
		(payload, { runQuery }) =>
			Effect.gen(function* () {
				const [outcomeRows, latencyRows, durableObjectRows] = yield* Effect.all([
					runQuery(Queries.cloudflareInfraWorkerDetailOutcomes, payload),
					runQuery(Queries.cloudflareInfraWorkerDetailLatency, payload),
					runQuery(Queries.cloudflareInfraWorkerDetailDurableObjects, payload),
				])
				return new CloudflareInfraWorkerDetailResponse({
					outcomeBuckets: outcomeRows.map((row) => ({ ...row })),
					latencyBuckets: latencyRows.map((row) => ({ ...row })),
					durableObjectBuckets: durableObjectRows.map((row) => ({ ...row })),
				})
			}),
	),
	"queryEngine.cloudflareInfraZoneSecurity": warehouseEndpoint(
		warehouse,
		CloudflareInfraZoneSecurityRequest,
		CloudflareInfraZoneSecurityResponse,
		(payload, { runQuery }) =>
			Effect.gen(function* () {
				const [bucketRows, topRows] = yield* Effect.all([
					runQuery(Queries.cloudflareInfraZoneFirewallTimeseries, payload),
					runQuery(Queries.cloudflareInfraZoneFirewallTop, payload),
				])
				return new CloudflareInfraZoneSecurityResponse({
					buckets: bucketRows.map((row) => ({ ...row })),
					top: topRows.map((row) => ({ ...row })),
					ignoredFilters: Integrations.cloudflareIgnoredFiltersFor(toCloudflareFilters(payload), [
						Integrations.CF_METRIC.firewallEvents,
					]),
				})
			}),
	),
	"queryEngine.cloudflareInfraZoneDns": warehouseEndpoint(
		warehouse,
		CloudflareInfraZoneDnsRequest,
		CloudflareInfraZoneDnsResponse,
		(payload, { runQuery }) =>
			Effect.gen(function* () {
				const [bucketRows, nameRows] = yield* Effect.all([
					runQuery(Queries.cloudflareInfraZoneDnsTimeseries, payload),
					runQuery(Queries.cloudflareInfraZoneDnsBreakdown, payload),
				])
				return new CloudflareInfraZoneDnsResponse({
					buckets: bucketRows.map((row) => ({ ...row })),
					names: nameRows.map((row) => ({ ...row })),
					ignoredFilters: Integrations.cloudflareIgnoredFiltersFor(toCloudflareFilters(payload), [
						Integrations.CF_METRIC.dnsQueries,
					]),
				})
			}),
	),
	"queryEngine.cloudflareInfraZoneBreakdown": warehouseEndpoint(
		warehouse,
		CloudflareInfraZoneBreakdownRequest,
		CloudflareInfraZoneBreakdownResponse,
		(payload, { runQuery }) =>
			Effect.gen(function* () {
				const [totalRows, coverageRows, zoneRows] = yield* Effect.all([
					runQuery(Queries.cloudflareInfraZoneBreakdownTotals, payload),
					runQuery(Queries.cloudflareInfraZoneBreakdownCoverage, payload),
					runQuery(Queries.cloudflareInfraZoneBreakdownZoneTotal, payload),
				])
				const topKeys = totalRows
					.filter((row) => row.key !== Integrations.CLOUDFLARE_BREAKDOWN_OTHER_KEY)
					.slice(0, Integrations.CLOUDFLARE_BREAKDOWN_SERIES_LIMIT)
					.map((row) => row.key)
				const bucketRows =
					topKeys.length === 0
						? []
						: yield* runQuery(Queries.cloudflareInfraZoneBreakdownTimeseries, {
								...payload,
								topKeys,
							})
				const coverage = coverageRows[0]
				const zoneRequests = zoneRows.find((row) => row.serviceName === payload.serviceName)
				return new CloudflareInfraZoneBreakdownResponse({
					totals: totalRows.map((row) => ({ ...row })),
					buckets: bucketRows.map((row) => ({ ...row })),
					unattributed: Math.max(
						0,
						(zoneRequests?.requests ?? 0) - (coverage?.attributedRequests ?? 0),
					),
					coverageStart:
						coverage?.coverageStart != null && coverage.coverageStart !== ""
							? coverage.coverageStart
							: null,
					ignoredFilters: Integrations.cloudflareIgnoredFiltersFor(
						toCloudflareFilters(payload),
						Integrations.cloudflareBreakdownMetrics(payload.dimension),
					),
				})
			}),
	),
	"queryEngine.cloudflareInfraZoneFacets": warehouseEndpoint(
		warehouse,
		CloudflareInfraZoneFacetsRequest,
		CloudflareInfraZoneFacetsResponse,
		(payload, { runQuery }) =>
			Effect.map(runQuery(Queries.cloudflareInfraZoneFacets, payload), (rows) => {
				const facet = (type: string) =>
					rows
						.filter((row) => row.facetType === type)
						.map((row) => ({ name: row.name, count: row.count || 0 }))
				return new CloudflareInfraZoneFacetsResponse({
					data: {
						hosts: facet("host"),
						cacheStatuses: facet("cacheStatus"),
						statusClasses: facet("statusClass"),
						paths: facet("path"),
						countries: facet("country"),
						methods: facet("method"),
						protocols: facet("protocol"),
						deviceTypes: facet("deviceType"),
					},
				})
			}),
	),
	"queryEngine.cloudflareInfraPlatformResources": warehouseEndpoint(
		warehouse,
		CloudflareInfraPlatformResourcesRequest,
		CloudflareInfraPlatformResourcesResponse,
		(payload, { runQuery }) =>
			Effect.gen(function* () {
				const [queueRows, doRows] = yield* Effect.all([
					runQuery(Queries.cloudflareInfraQueueGauges, payload),
					runQuery(Queries.cloudflareInfraDurableObjects, payload),
				])
				return new CloudflareInfraPlatformResourcesResponse({
					queues: queueRows.map((row) => ({ ...row })),
					durableObjects: doRows.map((row) => ({ ...row })),
				})
			}),
	),
	"queryEngine.cloudflareInfraWorkers": warehouseEndpoint(
		warehouse,
		CloudflareInfraWorkersRequest,
		CloudflareInfraWorkersResponse,
		(payload, { runQuery }) =>
			Effect.gen(function* () {
				const [counterRows, latencyRows] = yield* Effect.all([
					runQuery(Queries.cloudflareInfraWorkerCounters, payload),
					runQuery(Queries.cloudflareInfraWorkerLatency, payload),
				])
				const workerKey = (row: { serviceName: string; accountId: string }) =>
					`${row.accountId}|${row.serviceName}`
				const latencyByWorker = new Map(latencyRows.map((row) => [workerKey(row), row]))
				return new CloudflareInfraWorkersResponse({
					data: counterRows.map((row) => {
						const latency = latencyByWorker.get(workerKey(row))
						return {
							serviceName: row.serviceName,
							accountId: row.accountId,
							requests: row.requests,
							errors: row.errors,
							subrequests: row.subrequests,
							cpuP50Ms: latency?.cpuP50Ms ?? 0,
							cpuP99Ms: latency?.cpuP99Ms ?? 0,
							durationP50Ms: latency?.durationP50Ms ?? 0,
							durationP99Ms: latency?.durationP99Ms ?? 0,
						}
					}),
				})
			}),
	),
	"queryEngine.serviceCloudflareStats": warehouseEndpoint(
		warehouse,
		ServiceCloudflareStatsRequest,
		ServiceCloudflareStatsResponse,
		(payload, { runQuery }) =>
			Effect.gen(function* () {
				const [counterRows, latencyRows] = yield* Effect.all([
					runQuery(Queries.cloudflareServiceCounters, payload),
					runQuery(Queries.cloudflareServiceLatency, payload),
				])
				const latencyByService = new Map(latencyRows.map((row) => [row.serviceName, row]))
				return new ServiceCloudflareStatsResponse({
					data: counterRows.map((row) => ({
						serviceName: row.serviceName,
						requests: row.requests,
						errorCount: row.errorCount,
						latencyP99Ms: latencyByService.get(row.serviceName)?.latencyP99Ms ?? 0,
						cpuP99Ms: latencyByService.get(row.serviceName)?.cpuP99Ms ?? 0,
					})),
				})
			}),
	),
})

/** `servicePlanetScaleStats`: gauges, connections and storage merged by database (or branch). */
const planetscaleStats = (warehouse: FixtureWarehouse) =>
	warehouseEndpoint(
		warehouse,
		ServicePlanetScaleStatsRequest,
		ServicePlanetScaleStatsResponse,
		(payload, { runQuery }) =>
			Effect.gen(function* () {
				const byBranch = payload.database !== undefined
				const [gaugeRows, connectionRows, storageRows] = yield* Effect.all([
					runQuery(Queries.planetscaleServiceGauges, payload),
					runQuery(Queries.planetscaleServiceConnections, payload),
					runQuery(Queries.planetscaleServiceStorage, payload),
				])
				const keyOf = (row: { database: string; branch?: string }) =>
					byBranch ? `${row.database}\x00${row.branch ?? ""}` : row.database
				const branchOf = (row: { database: string } | { database: string; branch: string }) =>
					"branch" in row ? { branch: row.branch } : {}
				const connectionsByKey = new Map(connectionRows.map((row) => [keyOf(row), row]))
				const storageByKey = new Map(storageRows.map((row) => [keyOf(row), row]))
				const storageFor = (key: string) => ({
					storageUsedPercent: storageByKey.get(key)?.storageUsedPercent ?? 0,
					storageSamples: storageByKey.get(key)?.storageSamples ?? 0,
				})
				const seen = new Set(gaugeRows.map(keyOf))
				const fromGauges = gaugeRows.map((row) => ({
					...row,
					connectionsAvg: connectionsByKey.get(keyOf(row))?.connectionsAvg ?? 0,
					connectionsMax: connectionsByKey.get(keyOf(row))?.connectionsMax ?? 0,
					...storageFor(keyOf(row)),
				}))
				const fromConnections = connectionRows
					.filter((row) => !seen.has(keyOf(row)))
					.map((row) => ({
						...row,
						cpuMaxPercent: 0,
						memMaxPercent: 0,
						replicaLagMaxSeconds: 0,
						...storageFor(keyOf(row)),
					}))
				fromConnections.forEach((row) => seen.add(keyOf(row)))
				const fromStorage = storageRows
					.filter((row) => !seen.has(keyOf(row)))
					.map((row) => ({
						database: row.database,
						...branchOf(row),
						cpuMaxPercent: 0,
						memMaxPercent: 0,
						replicaLagMaxSeconds: 0,
						connectionsAvg: 0,
						connectionsMax: 0,
						storageUsedPercent: row.storageUsedPercent,
						storageSamples: row.storageSamples,
					}))
				return new ServicePlanetScaleStatsResponse({
					data: [...fromGauges, ...fromConnections, ...fromStorage],
				})
			}),
	)

const railwayAndPlanetscaleEndpoints = (
	warehouse: FixtureWarehouse,
): Readonly<Record<string, EndpointHandler>> => ({
	"queryEngine.servicePlanetScaleStats": planetscaleStats(warehouse),
	"queryEngine.planetscaleInfraTimeseries": warehouseEndpoint(
		warehouse,
		PlanetScaleInfraTimeseriesRequest,
		PlanetScaleInfraTimeseriesResponse,
		(payload, { runQuery }) =>
			Effect.map(
				runQuery(Queries.planetscaleInfraTimeseries, payload),
				(rows) =>
					new PlanetScaleInfraTimeseriesResponse({
						data: rows.map((row) => ({ ...row, bucket: DateTime.formatIso(row.bucket) })),
					}),
			),
	),
	"queryEngine.railwayInfraServices": warehouseEndpoint(
		warehouse,
		RailwayInfraServicesRequest,
		RailwayInfraRowsResponse,
		(payload, { runQuery }) =>
			Effect.map(
				runQuery(Queries.railwayInfraServices, payload),
				(rows) =>
					new RailwayInfraRowsResponse({
						data: rows.map((row) => ({ ...row, lastSeen: DateTime.formatIso(row.lastSeen) })),
					}),
			),
	),
	"queryEngine.railwayInfraServiceTimeseries": warehouseEndpoint(
		warehouse,
		RailwayInfraServiceTimeseriesRequest,
		RailwayInfraRowsResponse,
		(payload, { runQuery }) =>
			Effect.map(
				runQuery(Queries.railwayInfraServiceTimeseries, payload),
				(rows) =>
					new RailwayInfraRowsResponse({
						data: rows.map((row) => ({ ...row, bucket: DateTime.formatIso(row.bucket) })),
					}),
			),
	),
})

const gcpEndpoints = (warehouse: FixtureWarehouse): Readonly<Record<string, EndpointHandler>> => ({
	"queryEngine.gcpInfraPresence": warehouseEndpoint(
		warehouse,
		GcpInfraPresenceRequest,
		GcpInfraPresenceResponse,
		(payload, { runQuery }) =>
			Effect.map(runQuery(Queries.gcpInfraPresence, payload), (rows) => {
				const reported = new Set(rows.map((row) => row.metric))
				return new GcpInfraPresenceResponse({
					services: GCP_INFRA_SERVICE_IDS.filter((service) =>
						gcpInfraMetrics(service).some((metric) => reported.has(metric.name)),
					),
				})
			}),
	),
	"queryEngine.gcpInfraMetrics": warehouseEndpoint(
		warehouse,
		GcpInfraMetricsRequest,
		GcpInfraMetricsResponse,
		(payload, { runQuery }) =>
			Effect.map(
				runQuery(Queries.gcpInfraMetrics, payload),
				(rows) => new GcpInfraMetricsResponse({ data: rows }),
			),
	),
	"queryEngine.gcpInfraTimeseries": warehouseEndpoint(
		warehouse,
		GcpInfraTimeseriesRequest,
		GcpInfraTimeseriesResponse,
		(payload, { runQuery }) =>
			Effect.map(
				runQuery(Queries.gcpInfraTimeseries, payload),
				(rows) =>
					new GcpInfraTimeseriesResponse({
						data: rows.map((row) => ({ ...row, bucket: DateTime.formatIso(row.bucket) })),
					}),
			),
	),
	"queryEngine.gcpInfraSparklines": warehouseEndpoint(
		warehouse,
		GcpInfraSparklinesRequest,
		GcpInfraSparklinesResponse,
		(payload, { runQuery }) =>
			Effect.map(
				runQuery(Queries.gcpInfraSparklines, payload),
				(rows) =>
					new GcpInfraSparklinesResponse({
						data: rows.map((row) => ({ ...row, bucket: DateTime.formatIso(row.bucket) })),
					}),
			),
	),
	"queryEngine.gcpCloudSqlTopQueries": warehouseEndpoint(
		warehouse,
		GcpCloudSqlInstanceRequest,
		GcpCloudSqlTopQueriesResponse,
		(payload, { runQuery }) =>
			Effect.map(
				runQuery(Queries.gcpCloudSqlTopQueries, payload),
				(rows) => new GcpCloudSqlTopQueriesResponse({ data: rows }),
			),
	),
	"queryEngine.gcpCloudSqlDatabases": warehouseEndpoint(
		warehouse,
		GcpCloudSqlInstanceRequest,
		GcpCloudSqlDatabasesResponse,
		(payload, { runQuery }) =>
			Effect.map(
				runQuery(Queries.gcpCloudSqlDatabases, payload),
				(rows) => new GcpCloudSqlDatabasesResponse({ databases: rows.map((row) => row.database) }),
			),
	),
})

const toNumber = (value: unknown) => Number(value ?? 0)

/** `serviceDbQuerySummary`: the traced side of a Cloud SQL instance's page. */
const serviceDbQuerySummary = (warehouse: FixtureWarehouse) =>
	warehouseEndpoint(
		warehouse,
		ServiceDbQuerySummaryRequest,
		ServiceDbQuerySummaryResponse,
		(payload, { runQuery, runQueryFirst }) =>
			Effect.gen(function* () {
				const [summary, timeseriesRows, topQueryRows] = yield* Effect.all([
					runQueryFirst(Queries.serviceDbQuerySummary, payload),
					runQuery(Queries.serviceDbQueryTimeseries, payload),
					runQuery(Queries.serviceDbTopQueries, payload),
				])
				return new ServiceDbQuerySummaryResponse({
					summary:
						summary && toNumber(summary.queryCount) > 0
							? {
									queryCount: toNumber(summary.queryCount),
									estimatedQueryCount: toNumber(summary.estimatedQueryCount),
									errorCount: toNumber(summary.errorCount),
									estimatedErrorCount: toNumber(summary.estimatedErrorCount),
									errorRate: toNumber(summary.errorRate),
									avgDurationMs: toNumber(summary.avgDurationMs),
									p50DurationMs: toNumber(summary.p50DurationMs),
									p95DurationMs: toNumber(summary.p95DurationMs),
									activeServiceCount: toNumber(summary.activeServiceCount),
								}
							: null,
					timeseries: timeseriesRows.map((row) => ({
						bucket: DateTime.formatIso(row.bucket),
						queryCount: toNumber(row.queryCount),
						estimatedQueryCount: toNumber(row.estimatedQueryCount),
						errorCount: toNumber(row.errorCount),
						errorRate: toNumber(row.errorRate),
						avgDurationMs: toNumber(row.avgDurationMs),
						p50DurationMs: toNumber(row.p50DurationMs),
						p95DurationMs: toNumber(row.p95DurationMs),
					})),
					topQueries: topQueryRows.map((row) => ({
						queryKey: row.queryKey,
						queryLabel: row.queryLabel,
						sampleStatement: row.sampleStatement,
						sampleService: row.sampleService,
						serviceCount: toNumber(row.serviceCount),
						queryCount: toNumber(row.queryCount),
						estimatedQueryCount: toNumber(row.estimatedQueryCount),
						errorCount: toNumber(row.errorCount),
						errorRate: toNumber(row.errorRate),
						avgDurationMs: toNumber(row.avgDurationMs),
						p50DurationMs: toNumber(row.p50DurationMs),
						p95DurationMs: toNumber(row.p95DurationMs),
						lastSeen: DateTime.formatIso(row.lastSeen),
					})),
				})
			}),
	)

/** Every integration warehouse read, keyed `"<group>.<endpoint>"`. */
export const integrationWarehouseEndpoints = (
	warehouse: FixtureWarehouse,
): Readonly<Record<string, EndpointHandler>> => ({
	// `queryEngine.releasesList` is answered by the ops area (`ops/releases.ts`).
	"queryEngine.serviceDbQuerySummary": serviceDbQuerySummary(warehouse),
	...cloudflareEndpoints(warehouse),
	...railwayAndPlanetscaleEndpoints(warehouse),
	...gcpEndpoints(warehouse),
})
