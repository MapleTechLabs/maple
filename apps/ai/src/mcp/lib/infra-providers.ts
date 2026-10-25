/**
 * Infrastructure from connected integrations: Cloudflare zones and Workers, Railway services and
 * PlanetScale databases, read from the metrics their pollers and scrapes write. Same queries as the
 * web app's /infra/cloudflare, /infra/railway and /infra/planetscale pages, flattened onto the
 * shared infra row.
 */
import { DateTime, Effect, Option } from "effect"
import { CH } from "@maple/query-engine"
import * as Integrations from "@maple/query-engine-integrations"
import { WarehouseExecutor } from "@maple/query-engine/observability"
import type {
	InfraBreakdown,
	InfraEntityRow,
	InfraKindSection,
	InfraSeriesStats,
} from "@maple/domain/mcp-outputs"
import type { ProviderKind } from "./infra-params"
import {
	bucketSecondsFor,
	iso,
	matchesStatus,
	seriesStats,
	sortRows,
	type InfraFilters,
	type InfraSort,
	type InfraWindow,
	type SeriesSpec,
} from "./infra"

export const ZONE_SECTIONS = ["traffic", "breakdown", "security", "dns"] as const
export type ZoneSection = (typeof ZONE_SECTIONS)[number]
export const ZONE_DIMENSIONS = Integrations.CLOUDFLARE_BREAKDOWN_DIMENSIONS
export type ZoneDimension = Integrations.CloudflareBreakdownDimension

const ZONE_PREFIX = "cloudflare/"
const WORKER_PREFIX = "cloudflare-worker/"
const BREAKDOWN_ROWS = 25

const strip = (prefix: string, serviceName: string) =>
	serviceName.startsWith(prefix) ? serviceName.slice(prefix.length) : serviceName
const ratio = (part: number, whole: number): number | undefined => (whole > 0 ? part / whole : undefined)

const matchesSearch = (search: string | undefined) => (row: InfraEntityRow) =>
	search === undefined || row.name.toLowerCase().includes(search.toLowerCase())

/** Traffic kinds have no limit to be near: the worst one is the one failing most. */
const byTrouble = (rows: ReadonlyArray<InfraEntityRow>, sort: InfraSort): Array<InfraEntityRow> =>
	sort === "name" || sort === "last_seen"
		? sortRows(rows, sort)
		: [...rows].sort((a, b) => (b.errors ?? 0) - (a.errors ?? 0) || (b.requests ?? 0) - (a.requests ?? 0))

const zoneRow = (
	counters: Integrations.CloudflareZoneCountersOutput,
	latency: Integrations.CloudflareZoneLatencyOutput | undefined,
): InfraEntityRow => {
	const cacheHitRate = ratio(counters.cacheHits, counters.cacheableRequests)
	return {
		name: strip(ZONE_PREFIX, counters.serviceName),
		requests: counters.requests,
		errors: counters.errors5xx,
		errors4xx: counters.errors4xx,
		errorRate: ratio(counters.errors5xx, counters.requests) ?? 0,
		...(cacheHitRate === undefined ? undefined : { cacheHitRate }),
		bytes: counters.bytes,
		visits: counters.visits,
		...(latency === undefined
			? undefined
			: {
					latencyP50Ms: latency.ttfbP50Ms,
					latencyP95Ms: latency.ttfbP95Ms,
					latencyP99Ms: latency.ttfbP99Ms,
					originP95Ms: latency.originP95Ms,
				}),
	}
}

const workerKey = (row: { readonly serviceName: string; readonly accountId: string }) =>
	`${row.accountId}|${row.serviceName}`

const workerRow = (
	counters: Integrations.CloudflareWorkerCountersOutput,
	latency: Integrations.CloudflareWorkerLatencyOutput | undefined,
): InfraEntityRow => ({
	name: strip(WORKER_PREFIX, counters.serviceName),
	...(counters.accountId === "" ? undefined : { project: counters.accountId }),
	requests: counters.requests,
	errors: counters.errors,
	errorRate: ratio(counters.errors, counters.requests) ?? 0,
	subrequests: counters.subrequests,
	...(latency === undefined
		? undefined
		: {
				latencyP50Ms: latency.durationP50Ms,
				latencyP99Ms: latency.durationP99Ms,
				cpuTimeP50Ms: latency.cpuP50Ms,
				cpuTimeP99Ms: latency.cpuP99Ms,
			}),
})

const railwayRow = (row: Integrations.RailwayServicesOutput): InfraEntityRow => {
	const limited = row.cpuLimit > 0 || row.memoryLimit > 0
	const cpu = ratio(row.cpuAvg, row.cpuLimit)
	const cpuPeak = ratio(row.cpuMax, row.cpuLimit)
	const memory = ratio(row.memoryAvg, row.memoryLimit)
	const memoryPeak = ratio(row.memoryMax, row.memoryLimit)
	return {
		name: row.serviceName,
		project: row.projectName,
		environment: row.environmentName,
		lastSeen: iso(row.lastSeen),
		cpuCores: row.cpuAvg,
		cpuCoresPeak: row.cpuMax,
		...(cpu === undefined || cpuPeak === undefined ? undefined : { cpu, cpuPeak }),
		...(memory === undefined || memoryPeak === undefined ? undefined : { memory, memoryPeak }),
		memoryBytes: row.memoryAvg,
		replicas: row.replicas,
		saturation: Math.max(cpuPeak ?? 0, memoryPeak ?? 0),
		...(limited ? undefined : { unbounded: true }),
	}
}

interface PlanetScaleParts {
	readonly gauges?: Integrations.PlanetScaleDatabaseStatsOutput | undefined
	readonly connections?: Integrations.PlanetScaleConnectionsOutput | undefined
	readonly storage?: Integrations.PlanetScaleStorageOutput | undefined
}

const planetscaleRow = (database: string, parts: PlanetScaleParts): InfraEntityRow => {
	const { gauges, connections, storage } = parts
	// No free-space sample means unknown, never a full disk.
	const disk =
		storage === undefined || storage.storageSamples === 0 ? undefined : storage.storageUsedPercent / 100
	const cpuPeak = gauges === undefined ? 0 : gauges.cpuMaxPercent / 100
	const memoryPeak = gauges === undefined ? 0 : gauges.memMaxPercent / 100
	return {
		name: database,
		...(gauges === undefined
			? undefined
			: { cpuPeak, memoryPeak, replicaLagSeconds: gauges.replicaLagMaxSeconds }),
		...(disk === undefined ? undefined : { disk }),
		...(connections === undefined
			? undefined
			: { connections: connections.connectionsAvg, connectionsPeak: connections.connectionsMax }),
		saturation: Math.max(cpuPeak, memoryPeak, disk ?? 0),
	}
}

const fetchProviderRows = (kind: ProviderKind, window: InfraWindow) =>
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const params = { orgId: executor.orgId, startTime: window.startTime, endTime: window.endTime }
		const run = <Row>(query: CH.CompiledQueryInput<Row>, context: string) =>
			executor.compiledQuery(query, { profile: "aggregation", context })
		switch (kind) {
			case "cloudflare_zones": {
				const [counters, latency] = yield* Effect.all(
					[
						run(
							CH.compile(Integrations.cloudflareZoneCountersSQL(), params),
							"mcpCloudflareZoneCounters",
						),
						run(
							CH.compile(Integrations.cloudflareZoneLatencySQL(), params),
							"mcpCloudflareZoneLatency",
						),
					],
					{ concurrency: 2 },
				)
				const latencyByZone = new Map(latency.map((row) => [row.serviceName, row]))
				return counters.map((row) => zoneRow(row, latencyByZone.get(row.serviceName)))
			}
			case "cloudflare_workers": {
				const [counters, latency] = yield* Effect.all(
					[
						run(
							CH.compile(Integrations.cloudflareWorkerCountersSQL(), params),
							"mcpCloudflareWorkerCounters",
						),
						run(
							CH.compile(Integrations.cloudflareWorkerLatencySQL(), params),
							"mcpCloudflareWorkerLatency",
						),
					],
					{ concurrency: 2 },
				)
				const latencyByWorker = new Map(latency.map((row) => [workerKey(row), row]))
				return counters.map((row) => workerRow(row, latencyByWorker.get(workerKey(row))))
			}
			case "railway_services": {
				const rows = yield* run(
					CH.compile(Integrations.railwayServicesSQL(), params),
					"mcpRailwayServices",
				)
				return rows.map(railwayRow)
			}
			case "planetscale_databases": {
				const [gauges, connections, storage] = yield* Effect.all(
					[
						run(CH.compile(Integrations.planetscaleGaugesSQL(), params), "mcpPlanetScaleGauges"),
						run(
							CH.compile(Integrations.planetscaleConnectionsSQL(), params),
							"mcpPlanetScaleConnections",
						),
						run(
							CH.compile(Integrations.planetscaleStorageSQL(), params, {
								rowSchema: Integrations.planetscaleStorageRowSchema,
							}),
							"mcpPlanetScaleStorage",
						),
					],
					{ concurrency: 3 },
				)
				const databases = new Set([
					...gauges.map((row) => row.database),
					...connections.map((row) => row.database),
					...storage.map((row) => row.database),
				])
				return [...databases]
					.filter((database) => database !== "")
					.map((database) =>
						planetscaleRow(database, {
							gauges: gauges.find((row) => row.database === database),
							connections: connections.find((row) => row.database === database),
							storage: storage.find((row) => row.database === database),
						}),
					)
			}
		}
	})

export const PROVIDER_ENTITY_KINDS = [
	"cloudflare_zone",
	"cloudflare_worker",
	"railway_service",
	"planetscale_database",
] as const
export type ProviderEntityKind = (typeof PROVIDER_ENTITY_KINDS)[number]
export const isProviderEntityKind = (kind: string): kind is ProviderEntityKind =>
	PROVIDER_ENTITY_KINDS.some((provider) => provider === kind)

/** Which integration feeds each provider kind, to skip kinds nobody connected. */
export const PROVIDER_OF = {
	cloudflare_zones: "cloudflare",
	cloudflare_workers: "cloudflare",
	railway_services: "railway",
	planetscale_databases: "planetscale",
} as const satisfies Record<ProviderKind, string>

/** Traffic kinds have no limits: hot and at_limit read as the error-rate thresholds statusOf flags. */
const matchesTrafficStatus = (status: InfraFilters["status"]) => (row: InfraEntityRow) => {
	switch (status) {
		case undefined:
			return true
		case "hot":
			return (row.errorRate ?? 0) >= 0.01
		case "at_limit":
			return (row.errorRate ?? 0) >= 0.05
		case "no_limits":
			return false
	}
}

export interface ListProviderOptions {
	readonly window: InfraWindow
	readonly filters: InfraFilters
	readonly sort: InfraSort
	readonly limit: number
}

/**
 * One page of a provider kind, and whether the kind reported at all before filtering. Every query
 * is a fleet rollup, so filters apply after the read.
 */
export const listProviderKind = (kind: ProviderKind, options: ListProviderOptions) =>
	Effect.gen(function* () {
		const rows = yield* fetchProviderRows(kind, options.window)
		const { filters } = options
		const traffic = kind === "cloudflare_zones" || kind === "cloudflare_workers"
		const scoped = rows
			.filter(matchesSearch(filters.search))
			.filter((row) => filters.environment === undefined || row.environment === filters.environment)
		const filtered = scoped.filter(
			traffic ? matchesTrafficStatus(filters.status) : matchesStatus(filters.status),
		)
		const sorted = traffic ? byTrouble(filtered, options.sort) : sortRows(filtered, options.sort)
		const section = {
			kind,
			// Before the status filter, so "1 of 3 match status" reads against the fleet.
			summary: { total: scoped.length },
			rows: sorted.slice(0, options.limit),
			truncated: sorted.length > options.limit,
		} satisfies InfraKindSection
		return { section, reported: rows.length > 0 }
	})

export interface ProviderInspectTarget {
	readonly kind: ProviderEntityKind
	readonly name: string
	readonly environment?: string | undefined
	readonly section?: ZoneSection | undefined
	readonly dimension?: ZoneDimension | undefined
}

export interface ProviderInspectResult {
	readonly found: boolean
	readonly entity?: InfraEntityRow
	readonly details?: Record<string, string>
	readonly series: ReadonlyArray<InfraSeriesStats>
	readonly breakdowns?: ReadonlyArray<InfraBreakdown>
	readonly section?: ZoneSection
}

const NOT_FOUND: ProviderInspectResult = { found: false, series: [] }

/** Cloudflare buckets come back as ISO strings; an unparsable one is dropped, not guessed. */
const isoPoint = (bucket: string, value: number) =>
	Option.toArray(DateTime.make(bucket)).map((at) => ({ bucket: DateTime.toUtc(at), value }))

/** Sums a bucket × key series into one point per bucket. */
const perBucket = <Row extends { readonly bucket: string }>(
	rows: ReadonlyArray<Row>,
	value: (row: Row) => number,
	include: (row: Row) => boolean = () => true,
) => {
	const totals = new Map<string, number>()
	for (const row of rows) {
		if (include(row)) totals.set(row.bucket, (totals.get(row.bucket) ?? 0) + value(row))
		else if (!totals.has(row.bucket)) totals.set(row.bucket, 0)
	}
	return [...totals.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.flatMap(([bucket, v]) => isoPoint(bucket, v))
}

/** Totals per key, largest first, as a breakdown table. */
const keyTotals = <Row>(
	title: string,
	keyLabel: string,
	rows: ReadonlyArray<Row>,
	key: (row: Row) => string,
	value: (row: Row) => number,
): InfraBreakdown => {
	const totals = new Map<string, number>()
	for (const row of rows) totals.set(key(row), (totals.get(key(row)) ?? 0) + value(row))
	const total = [...totals.values()].reduce((sum, v) => sum + v, 0)
	return {
		title,
		keyLabel,
		valueLabels: ["Count", "Share"],
		rows: [...totals.entries()]
			.sort(([, a], [, b]) => b - a)
			.slice(0, BREAKDOWN_ROWS)
			.map(([k, v]) => ({ key: k === "" ? "(none)" : k, values: [v, total > 0 ? v / total : 0] })),
	}
}

const spec = (label: string, unit: SeriesSpec["unit"]): SeriesSpec => ({ label, unit })

const utcPoints = <Row extends { readonly bucket: DateTime.Utc }>(
	rows: ReadonlyArray<Row>,
	value: (row: Row) => number | undefined,
) =>
	rows.flatMap((row) => {
		const v = value(row)
		return v === undefined ? [] : [{ bucket: row.bucket, value: v }]
	})

export const inspectProvider = (target: ProviderInspectTarget, window: InfraWindow) =>
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const bucketSeconds = bucketSecondsFor(window)
		const params = { orgId: executor.orgId, startTime: window.startTime, endTime: window.endTime }
		const run = <Row>(query: CH.CompiledQueryInput<Row>, context: string) =>
			executor.compiledQuery(query, { profile: "aggregation", context })
		const find = (kind: ProviderKind) =>
			listProviderKind(kind, { window, filters: {}, sort: "name", limit: 1000 }).pipe(
				Effect.map(({ section }) => section.rows.filter((row) => row.name === target.name)),
			)

		switch (target.kind) {
			case "cloudflare_zone": {
				const entity = (yield* find("cloudflare_zones"))[0]
				if (entity === undefined) return NOT_FOUND
				const section = target.section ?? "traffic"
				const zone = { ...params, serviceName: `${ZONE_PREFIX}${target.name}`, bucketSeconds }
				switch (section) {
					case "traffic": {
						const [status, cache, latency] = yield* Effect.all(
							[
								run(
									CH.compile(Integrations.cloudflareZoneStatusTimeseriesSQL(), zone),
									"mcpCloudflareZoneStatus",
								),
								run(
									CH.compile(Integrations.cloudflareZoneCacheTimeseriesSQL(), zone),
									"mcpCloudflareZoneCache",
								),
								run(
									CH.compile(Integrations.cloudflareZoneLatencyTimeseriesSQL(), zone),
									"mcpCloudflareZoneLatency",
								),
							],
							{ concurrency: 3 },
						)
						const latencyPoints = (
							pick: (row: Integrations.CloudflareZoneLatencyTimeseriesOutput) => number,
						) => latency.flatMap((row) => isoPoint(row.bucket, pick(row)))
						return {
							found: true,
							entity,
							section,
							series: [
								...seriesStats(
									spec("requests per bucket", "count"),
									perBucket(status, (r) => r.requests),
								),
								...seriesStats(
									spec("5xx per bucket", "count"),
									perBucket(
										status,
										(r) => r.requests,
										(r) => r.statusClass === "5xx",
									),
								),
								...seriesStats(
									spec("edge TTFB p95", "ms"),
									latencyPoints((r) => r.ttfbP95Ms),
								),
								...seriesStats(
									spec("origin duration p95", "ms"),
									latencyPoints((r) => r.originP95Ms),
								),
							],
							breakdowns: [
								keyTotals(
									"Requests by status class",
									"Status",
									status,
									(r) => r.statusClass,
									(r) => r.requests,
								),
								keyTotals(
									"Requests by cache status",
									"Cache status",
									cache,
									(r) => r.cacheStatus,
									(r) => r.requests,
								),
							],
						} satisfies ProviderInspectResult
					}
					case "breakdown": {
						const dimension = target.dimension ?? "path"
						const rows = yield* run(
							CH.compile(
								Integrations.cloudflareZoneBreakdownTotalsSQL(dimension, {}, BREAKDOWN_ROWS),
								zone,
							),
							"mcpCloudflareZoneBreakdown",
						)
						return {
							found: true,
							entity,
							section,
							series: [],
							breakdowns: [
								{
									title: `Top ${dimension} values by requests`,
									keyLabel: dimension,
									valueLabels: ["Requests", "5xx", "Bytes"],
									rows: rows.map((row) => ({
										key: row.key === "" ? "(none)" : row.key,
										values: [row.requests, row.errors5xx, row.bytes],
									})),
								},
							],
						} satisfies ProviderInspectResult
					}
					case "security": {
						const [series, top] = yield* Effect.all(
							[
								run(
									CH.compile(Integrations.cloudflareZoneFirewallTimeseriesSQL(), zone),
									"mcpCloudflareZoneFirewall",
								),
								run(
									CH.compile(Integrations.cloudflareZoneFirewallTopSQL(), zone),
									"mcpCloudflareZoneFirewallTop",
								),
							],
							{ concurrency: 2 },
						)
						return {
							found: true,
							entity,
							section,
							series: seriesStats(
								spec("firewall events per bucket", "count"),
								perBucket(series, (r) => r.events),
							),
							breakdowns: [
								keyTotals(
									"Firewall events by action",
									"Action",
									series,
									(r) => r.action,
									(r) => r.events,
								),
								{
									title: "Top firewall rules",
									keyLabel: "source / action / rule / host",
									valueLabels: ["Events"],
									rows: top.map((row) => ({
										key: [row.source, row.action, row.ruleId, row.host]
											.map((part) => part || "-")
											.join(" / "),
										values: [row.events],
									})),
								},
							],
						} satisfies ProviderInspectResult
					}
					case "dns": {
						const [series, names] = yield* Effect.all(
							[
								run(
									CH.compile(Integrations.cloudflareZoneDnsTimeseriesSQL(), zone),
									"mcpCloudflareZoneDns",
								),
								run(
									CH.compile(Integrations.cloudflareZoneDnsBreakdownSQL(), zone),
									"mcpCloudflareZoneDnsNames",
								),
							],
							{ concurrency: 2 },
						)
						return {
							found: true,
							entity,
							section,
							series: [
								...seriesStats(
									spec("DNS queries per bucket", "count"),
									perBucket(series, (r) => r.queries),
								),
								...seriesStats(
									spec("NXDOMAIN per bucket", "count"),
									perBucket(
										series,
										(r) => r.queries,
										(r) => r.responseCode === "NXDOMAIN",
									),
								),
							],
							breakdowns: [
								keyTotals(
									"DNS queries by response code",
									"Response code",
									series,
									(r) => r.responseCode,
									(r) => r.queries,
								),
								{
									title: "Top query names",
									keyLabel: "Name",
									valueLabels: ["Queries", "NXDOMAIN"],
									rows: names.map((row) => ({
										key: row.queryName || "(none)",
										values: [row.queries, row.nxdomain],
									})),
								},
							],
						} satisfies ProviderInspectResult
					}
				}
				return NOT_FOUND
			}
			case "cloudflare_worker": {
				const matches = yield* find("cloudflare_workers")
				// Same script name in two accounts: show the busiest, say so.
				const entity = [...matches].sort((a, b) => (b.requests ?? 0) - (a.requests ?? 0))[0]
				if (entity === undefined) return NOT_FOUND
				const worker = {
					...params,
					serviceName: `${WORKER_PREFIX}${target.name}`,
					bucketSeconds,
					// The list groups by account with "" for none, so "" scopes to exactly those rows.
					accountId: entity.project ?? "",
				}
				const opts = { byAccount: true }
				const [outcomes, latency, durableObjects] = yield* Effect.all(
					[
						run(
							CH.compile(Integrations.cloudflareWorkerOutcomeTimeseriesSQL(opts), worker),
							"mcpCloudflareWorkerOutcomes",
						),
						run(
							CH.compile(Integrations.cloudflareWorkerLatencyTimeseriesSQL(opts), worker),
							"mcpCloudflareWorkerLatency",
						),
						run(
							CH.compile(Integrations.cloudflareWorkerDurableObjectTimeseriesSQL(opts), worker),
							"mcpCloudflareWorkerDurableObjects",
						),
					],
					{ concurrency: 3 },
				)
				const latencyPoints = (
					pick: (row: Integrations.CloudflareWorkerLatencyTimeseriesOutput) => number,
				) => latency.flatMap((row) => isoPoint(row.bucket, pick(row)))
				const doRequests = durableObjects.reduce((sum, row) => sum + row.requests, 0)
				return {
					found: true,
					entity,
					...(matches.length > 1
						? {
								details: {
									Accounts: `${matches.length} accounts run a Worker with this name; showing the busiest`,
								},
							}
						: undefined),
					series: [
						...seriesStats(
							spec("invocations per bucket", "count"),
							perBucket(outcomes, (r) => r.requests),
						),
						...seriesStats(
							spec("non-success invocations per bucket", "count"),
							perBucket(
								outcomes,
								(r) => r.requests,
								(r) => r.status !== "success",
							),
						),
						...seriesStats(
							spec("wall duration p99", "ms"),
							latencyPoints((r) => r.durationP99Ms),
						),
						...seriesStats(
							spec("CPU time p99", "ms"),
							latencyPoints((r) => r.cpuP99Ms),
						),
						...(doRequests > 0
							? seriesStats(
									spec("Durable Object requests per bucket", "count"),
									durableObjects.flatMap((row) => isoPoint(row.bucket, row.requests)),
								)
							: []),
					],
					breakdowns: [
						keyTotals(
							"Invocations by outcome",
							"Outcome",
							outcomes,
							(r) => r.status,
							(r) => r.requests,
						),
					],
				} satisfies ProviderInspectResult
			}
			case "railway_service": {
				const services = yield* run(
					CH.compile(Integrations.railwayServicesSQL(), params),
					"mcpRailwayServices",
				)
				const matches = services.filter(
					(row) =>
						row.serviceName === target.name &&
						(target.environment === undefined || row.environmentName === target.environment),
				)
				const match = [...matches].sort((a, b) => b.cpuAvg - a.cpuAvg)[0]
				if (match === undefined) return NOT_FOUND
				const rows = yield* run(
					CH.compile(Integrations.railwayServiceTimeseriesSQL(), {
						...params,
						bucketSeconds: Math.max(60, bucketSeconds),
						environmentId: match.environmentId,
						serviceId: match.serviceId,
					}),
					"mcpRailwayServiceTimeseries",
				)
				const limited = match.cpuLimit > 0
				return {
					found: true,
					entity: railwayRow(match),
					details: {
						"CPU limit": `${match.cpuLimit} vCPU`,
						"Memory limit": `${(match.memoryLimit / 1024 ** 3).toFixed(1)} GiB`,
						...(matches.length > 1
							? {
									Environments: `${matches.length} environments run this service (${matches.map((m) => m.environmentName).join(", ")}); pass environment to pick one`,
								}
							: undefined),
					},
					series: [
						...(limited
							? seriesStats(
									spec("CPU (peak replica sum, of limit)", "fraction"),
									utcPoints(rows, (r) => ratio(r.cpuMax, r.cpuLimit)),
								)
							: seriesStats(
									spec("CPU (peak)", "cores"),
									utcPoints(rows, (r) => r.cpuMax),
								)),
						...(match.memoryLimit > 0
							? seriesStats(
									spec("memory (peak, of limit)", "fraction"),
									utcPoints(rows, (r) => ratio(r.memoryMax, r.memoryLimit)),
								)
							: []),
						...seriesStats(
							spec("memory (avg)", "bytes"),
							utcPoints(rows, (r) => r.memoryAvg),
						),
						...seriesStats(
							spec("network received per sample", "bytes"),
							utcPoints(rows, (r) => r.networkRx),
						),
						...seriesStats(
							spec("network sent per sample", "bytes"),
							utcPoints(rows, (r) => r.networkTx),
						),
						...seriesStats(
							spec("volume disk used", "bytes"),
							utcPoints(rows, (r) => (r.diskVolume > 0 ? r.diskVolume : undefined)),
						),
						...seriesStats(
							spec("replicas", "count"),
							utcPoints(rows, (r) => r.replicas),
						),
					],
				} satisfies ProviderInspectResult
			}
			case "planetscale_database": {
				const entity = (yield* find("planetscale_databases"))[0]
				if (entity === undefined) return NOT_FOUND
				const rows = yield* run(
					CH.compile(Integrations.planetscaleInfraTimeseriesSQL(), {
						...params,
						bucketSeconds: Math.max(60, bucketSeconds),
						database: target.name,
					}),
					"mcpPlanetScaleTimeseries",
				)
				return {
					found: true,
					entity,
					series: [
						...seriesStats(
							spec("CPU (busiest pod)", "fraction"),
							utcPoints(rows, (r) => r.cpuMaxPercent / 100),
						),
						...seriesStats(
							spec("memory (busiest pod)", "fraction"),
							utcPoints(rows, (r) => r.memMaxPercent / 100),
						),
						...seriesStats(
							spec("connections", "count"),
							utcPoints(rows, (r) => r.connectionsAvg),
						),
						...seriesStats(
							spec("replica lag (worst)", "seconds"),
							utcPoints(rows, (r) => r.replicaLagMaxSeconds),
						),
						...seriesStats(
							spec("storage used (fullest branch)", "fraction"),
							utcPoints(rows, (r) =>
								r.storageSamples > 0 && r.storageUsedPercent !== null
									? r.storageUsedPercent / 100
									: undefined,
							),
						),
					],
				} satisfies ProviderInspectResult
			}
		}
	}).pipe(Effect.map((result): ProviderInspectResult => result))
