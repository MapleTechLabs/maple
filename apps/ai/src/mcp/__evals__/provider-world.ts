/**
 * Fixture world for the provider infra kinds: Cloudflare zones and Workers, Railway services and
 * PlanetScale databases, answered by the aliases their queries select. One zone serves 5xx above the
 * 5% line, one Railway service runs at its CPU limit, one database's storage is filling up.
 */
import { parseWarehouseDateTime } from "@maple/query-engine"
import type { FixtureRule } from "./fake-warehouse"

export const PROVIDER_WORLD = {
	failingZone: "api.example.com",
	hotRailwayService: "api",
	fullDatabase: "maple-prod",
} as const

const BUCKETS = 12

const has = (sql: string, alias: string) => sql.includes(` AS ${alias}`)
const bucketed = (sql: string) => has(sql, "bucket")
const mentions = (sql: string, text: string) => sql.includes(text)

const windowOf = (sql: string): { start: number; end: number } => {
	const stamps = [...sql.matchAll(/'(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)'/g)].map((m) =>
		parseWarehouseDateTime(m[1] ?? ""),
	)
	const start = stamps[0] ?? parseWarehouseDateTime("2026-10-01 06:00:00")
	return { start, end: stamps[1] ?? start + 3_600_000 }
}

/** Bucket starts across the window, with the shape `t` in 0..1 for curves. */
const buckets = (sql: string) => {
	const { start, end } = windowOf(sql)
	const step = (end - start) / BUCKETS
	return Array.from({ length: BUCKETS }, (_, i) => ({ at: start + i * step, t: i / BUCKETS }))
}
const isoZ = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`
const wire = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ")

interface Zone {
	readonly name: string
	readonly requests: number
	readonly rate5xx: number
	readonly cacheHit: number
	readonly ttfbP95: number
}

const FAILING_ZONE: Zone = {
	name: PROVIDER_WORLD.failingZone,
	requests: 410_000,
	rate5xx: 0.065,
	cacheHit: 0.12,
	ttfbP95: 890,
}
const ZONES: ReadonlyArray<Zone> = [
	{ name: "shop.example.com", requests: 1_240_000, rate5xx: 0.003, cacheHit: 0.81, ttfbP95: 142 },
	FAILING_ZONE,
	{ name: "status.example.com", requests: 8_200, rate5xx: 0, cacheHit: 0.95, ttfbP95: 38 },
]

/** The zone a single-zone query names, or the failing one. */
const zoneFor = (sql: string): Zone =>
	ZONES.find((zone) => mentions(sql, `'cloudflare/${zone.name}'`)) ?? FAILING_ZONE

const WORKERS = [
	{
		name: "edge-router",
		accountId: "acc_7f3e",
		requests: 2_100_000,
		errors: 44_000,
		cpuP99: 18,
		durP99: 210,
	},
	{
		name: "image-resizer",
		accountId: "acc_7f3e",
		requests: 96_000,
		errors: 120,
		cpuP99: 140,
		durP99: 1_900,
	},
] as const

const RAILWAY = [
	{
		service: "api",
		env: "production",
		envId: "env_prod",
		id: "svc_api",
		cpu: 1.85,
		cpuMax: 1.98,
		cpuLimit: 2,
		memGiB: 1.4,
	},
	{
		service: "worker",
		env: "production",
		envId: "env_prod",
		id: "svc_worker",
		cpu: 0.3,
		cpuMax: 0.6,
		cpuLimit: 2,
		memGiB: 0.6,
	},
	{
		service: "api",
		env: "staging",
		envId: "env_stg",
		id: "svc_api",
		cpu: 0.05,
		cpuMax: 0.1,
		cpuLimit: 1,
		memGiB: 0.3,
	},
] as const
const GiB = 1024 ** 3

const DATABASES = [
	{
		database: PROVIDER_WORLD.fullDatabase,
		cpu: 64,
		mem: 71,
		lag: 0.4,
		storage: 78.5,
		conns: 42,
		connsMax: 118,
	},
	{ database: "maple-analytics", cpu: 12, mem: 33, lag: 0, storage: 21, conns: 4, connsMax: 9 },
] as const

export const providerFixtureRules = (): FixtureRule[] => [
	// Cloudflare zones: the fleet list, then single-zone views.
	{
		match: (sql) => has(sql, "cacheableRequests"),
		rows: ZONES.map((zone) => ({
			serviceName: `cloudflare/${zone.name}`,
			requests: zone.requests,
			errors5xx: Math.round(zone.requests * zone.rate5xx),
			errors4xx: Math.round(zone.requests * 0.02),
			requests2xx: Math.round(zone.requests * 0.9),
			requests3xx: Math.round(zone.requests * 0.05),
			cacheHits: Math.round(zone.requests * 0.7 * zone.cacheHit),
			cacheableRequests: Math.round(zone.requests * 0.7),
			bytes: zone.requests * 18_000,
			visits: Math.round(zone.requests * 0.1),
		})),
	},
	{
		match: (sql) => has(sql, "ttfbP95Ms") && !bucketed(sql),
		rows: ZONES.map((zone) => ({
			serviceName: `cloudflare/${zone.name}`,
			ttfbP50Ms: zone.ttfbP95 / 3,
			ttfbP95Ms: zone.ttfbP95,
			ttfbP99Ms: zone.ttfbP95 * 1.8,
			originP50Ms: zone.ttfbP95 / 4,
			originP95Ms: zone.ttfbP95 * 0.8,
			originP99Ms: zone.ttfbP95 * 1.5,
		})),
	},
	{
		match: (sql) => has(sql, "statusClass") && bucketed(sql),
		rows: (sql) => {
			const zone = zoneFor(sql)
			const per = zone.requests / BUCKETS
			// 5xx climb in the last third: the incident an agent should find.
			return buckets(sql).flatMap(({ at, t }) => [
				{ bucket: isoZ(at), statusClass: "2xx", requests: Math.round(per * 0.9) },
				{ bucket: isoZ(at), statusClass: "4xx", requests: Math.round(per * 0.02) },
				{
					bucket: isoZ(at),
					statusClass: "5xx",
					requests: Math.round(per * zone.rate5xx * (t > 0.66 ? 2.5 : 0.25)),
				},
			])
		},
	},
	{
		match: (sql) => has(sql, "cacheStatus") && bucketed(sql),
		rows: (sql) => {
			const zone = zoneFor(sql)
			const per = zone.requests / BUCKETS
			return buckets(sql).flatMap(({ at }) => [
				{ bucket: isoZ(at), cacheStatus: "hit", requests: Math.round(per * 0.7 * zone.cacheHit) },
				{
					bucket: isoZ(at),
					cacheStatus: "miss",
					requests: Math.round(per * 0.7 * (1 - zone.cacheHit)),
				},
				{ bucket: isoZ(at), cacheStatus: "dynamic", requests: Math.round(per * 0.3) },
			])
		},
	},
	{
		match: (sql) => has(sql, "ttfbP95Ms") && bucketed(sql),
		rows: (sql) => {
			const zone = zoneFor(sql)
			return buckets(sql).map(({ at, t }) => ({
				bucket: isoZ(at),
				ttfbP50Ms: zone.ttfbP95 / 3,
				ttfbP95Ms: zone.ttfbP95 * (t > 0.66 ? 1.6 : 0.8),
				ttfbP99Ms: zone.ttfbP95 * 2,
				originP50Ms: zone.ttfbP95 / 4,
				originP95Ms: zone.ttfbP95 * (t > 0.66 ? 1.4 : 0.7),
				originP99Ms: zone.ttfbP95 * 1.6,
			}))
		},
	},
	{
		match: (sql) => has(sql, "key") && has(sql, "errors5xx"),
		rows: [
			{ key: "/v1/checkout", requests: 120_000, errors5xx: 21_000, bytes: 2.1e9 },
			{ key: "/v1/cart", requests: 98_000, errors5xx: 4_100, bytes: 1.2e9 },
			{ key: "/health", requests: 60_000, errors5xx: 0, bytes: 1.2e7 },
		],
	},
	{
		match: (sql) => has(sql, "ruleId"),
		rows: [
			{
				source: "firewallManaged",
				action: "block",
				ruleId: "100015",
				host: PROVIDER_WORLD.failingZone,
				events: 5_400,
			},
			{
				source: "ratelimit",
				action: "challenge",
				ruleId: "rl-login",
				host: PROVIDER_WORLD.failingZone,
				events: 1_200,
			},
		],
	},
	{
		match: (sql) => has(sql, "action") && has(sql, "events") && bucketed(sql),
		rows: (sql) =>
			buckets(sql).flatMap(({ at, t }) => [
				{ bucket: isoZ(at), action: "block", events: Math.round(300 + 600 * t) },
				{ bucket: isoZ(at), action: "challenge", events: 100 },
			]),
	},
	{
		match: (sql) => has(sql, "queryName"),
		rows: [
			{ queryName: "api.example.com", queries: 88_000, nxdomain: 0 },
			{ queryName: "old-api.example.com", queries: 3_100, nxdomain: 3_100 },
		],
	},
	{
		match: (sql) => has(sql, "responseCode") && bucketed(sql),
		rows: (sql) =>
			buckets(sql).flatMap(({ at }) => [
				{ bucket: isoZ(at), responseCode: "NOERROR", queries: 7_300 },
				{ bucket: isoZ(at), responseCode: "NXDOMAIN", queries: 260 },
			]),
	},
	// Cloudflare Workers.
	{
		match: (sql) => has(sql, "subrequests"),
		rows: WORKERS.map((w) => ({
			serviceName: `cloudflare-worker/${w.name}`,
			accountId: w.accountId,
			requests: w.requests,
			errors: w.errors,
			subrequests: w.requests * 2,
		})),
	},
	{
		match: (sql) => has(sql, "doWallP99Ms"),
		rows: (sql) =>
			buckets(sql).map(({ at }) => ({
				bucket: isoZ(at),
				cpuP50Ms: 4,
				cpuP99Ms: 18,
				durationP50Ms: 40,
				durationP99Ms: 210,
				doWallP50Ms: 0,
				doWallP99Ms: 0,
			})),
	},
	{
		match: (sql) => has(sql, "cpuP99Ms") && !bucketed(sql),
		rows: WORKERS.map((w) => ({
			serviceName: `cloudflare-worker/${w.name}`,
			accountId: w.accountId,
			cpuP50Ms: w.cpuP99 / 4,
			cpuP99Ms: w.cpuP99,
			durationP50Ms: w.durP99 / 5,
			durationP99Ms: w.durP99,
		})),
	},
	{
		match: (sql) => bucketed(sql) && mentions(sql, "cloudflare.durable_object.requests"),
		rows: [],
	},
	{
		match: (sql) => has(sql, "status") && bucketed(sql) && mentions(sql, "cloudflare.worker.requests"),
		rows: (sql) =>
			buckets(sql).flatMap(({ at }) => [
				{ bucket: isoZ(at), status: "success", requests: 170_000 },
				{ bucket: isoZ(at), status: "scriptThrewException", requests: 3_700 },
			]),
	},
	// Railway.
	{
		match: (sql) => has(sql, "networkRx"),
		rows: (sql) => {
			const service =
				RAILWAY.find((s) => mentions(sql, `'${s.envId}'`) && mentions(sql, `'${s.id}'`)) ?? RAILWAY[0]
			return buckets(sql).map(({ at, t }) => ({
				bucket: wire(at),
				cpuAvg: service.cpu * (0.8 + 0.3 * t),
				cpuMax: Math.min(service.cpuLimit, service.cpuMax * (0.8 + 0.25 * t)),
				cpuLimit: service.cpuLimit,
				memoryAvg: service.memGiB * GiB,
				memoryMax: service.memGiB * GiB * 1.1,
				memoryLimit: 4 * GiB,
				networkRx: 2.4e6,
				networkTx: 9.1e6,
				diskVolume: 0,
				diskEphemeral: 1.1e8,
				replicas: 2,
			}))
		},
	},
	{
		match: (sql) => has(sql, "replicas") && has(sql, "projectName"),
		rows: (sql) =>
			RAILWAY.map((s) => ({
				environmentId: s.envId,
				serviceId: s.id,
				serviceName: s.service,
				projectName: "shop",
				environmentName: s.env,
				cpuAvg: s.cpu,
				cpuMax: s.cpuMax,
				cpuLimit: s.cpuLimit,
				memoryAvg: s.memGiB * GiB,
				memoryMax: s.memGiB * GiB * 1.1,
				memoryLimit: 4 * GiB,
				replicas: 2,
				lastSeen: wire(windowOf(sql).end - 60_000),
			})),
	},
	// PlanetScale: the bucketed series first, since it also selects cpuMaxPercent.
	{
		match: (sql) => has(sql, "connectionsAvg") && bucketed(sql),
		rows: (sql) => {
			const db = DATABASES.find((d) => mentions(sql, `'${d.database}'`)) ?? DATABASES[0]
			return buckets(sql).map(({ at, t }) => ({
				bucket: wire(at),
				connectionsAvg: db.conns,
				cpuMaxPercent: db.cpu * (0.7 + 0.4 * t),
				memMaxPercent: db.mem,
				replicaLagMaxSeconds: db.lag,
				storageUsedPercent: db.storage - 2 + 2 * t,
				storageSamples: 4,
			}))
		},
	},
	{
		match: (sql) => has(sql, "cpuMaxPercent"),
		rows: DATABASES.map((d) => ({
			database: d.database,
			cpuMaxPercent: d.cpu,
			memMaxPercent: d.mem,
			replicaLagMaxSeconds: d.lag,
		})),
	},
	{
		match: (sql) => has(sql, "connectionsMax"),
		rows: DATABASES.map((d) => ({
			database: d.database,
			connectionsAvg: d.conns,
			connectionsMax: d.connsMax,
		})),
	},
	{
		match: (sql) => has(sql, "storageSamples"),
		rows: DATABASES.map((d) => ({
			database: d.database,
			storageUsedPercent: d.storage,
			storageSamples: 40,
		})),
	},
]
