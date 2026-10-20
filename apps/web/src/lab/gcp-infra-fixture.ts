// The Google Cloud list lab's fixtures, shared with apps/web's `/lab/gcp-infra`.
// Imports stay relative: the Foldkit typecheck resolves `@/` to its own source.

import type { GcpInfraServiceId } from "@maple/domain/gcp-infra"

import type { GcpCloudSqlInstance } from "../components/infra/gcp/inventory"
import type { GcpFleetRead, GcpProjectHealth, GcpSparklinePoint } from "../components/infra/gcp/list-model"
import type { GcpMetricPoint, GcpView } from "../components/infra/gcp/tabs"

// Three projects over the last 12 hours, as the Paper artboards draw them: a Cloud Run service
// serving 5xx, a failing 1st gen function, slow services, one idle but billed; a growing push
// backlog; Cloud SQL instances at their connection limit, slow, MySQL, and with Query Insights off.

export const START = "2026-10-14 00:00:00"
export const END = "2026-10-14 12:00:00"
export const BUCKET_SECONDS = 1800
const BUCKETS = 25
const START_MS = Date.parse("2026-10-14T00:00:00.000Z")

const point = (
	keys: ReadonlyArray<string>,
	metric: string,
	label: string,
	total: number,
	samples = 1,
): GcpMetricPoint => ({ keys, metric, label, total, samples })

/** A gauge's mean over the window, as `samples` one-minute points. */
const gauge = (keys: ReadonlyArray<string>, metric: string, label: string, mean: number) =>
	point(keys, metric, label, mean * 720, 720)

const RUN = "gcp.cloud_run"
const FUNCTION = "gcp.cloud_functions"
const SUB = "gcp.pubsub.subscription"
const SQL = "gcp.cloud_sql"

interface Service {
	readonly name: string
	readonly project: string
	readonly region: string
	readonly requests: number
	readonly c4xx: number
	readonly c5xx: number
	/** Seconds. */
	readonly p95?: number
	readonly instances: number
	readonly cpu?: number
	readonly billable?: number
	/** Requests per bucket, relative: the sparkline's form. */
	readonly trend: (bucket: number) => number
}

const flat = () => 1
const wave = (bucket: number) => 1 + 0.08 * Math.sin(bucket / 2)
const bump = (at: number) => (bucket: number) => 1 + 1.6 * Math.exp(-((bucket - at) ** 2) / 3)
const rising = (bucket: number) => 0.85 + bucket / 80

const SERVICES: ReadonlyArray<Service> = [
	{
		name: "checkout-api",
		project: "acme-prod",
		region: "us-central1",
		requests: 1_210_000,
		c4xx: 24_000,
		c5xx: 41_140,
		p95: 1.84,
		instances: 6,
		cpu: 0.71,
		trend: bump(12),
	},
	{
		name: "search",
		project: "acme-prod",
		region: "us-central1",
		requests: 880_000,
		c4xx: 8_800,
		c5xx: 1_850,
		p95: 1.21,
		instances: 3,
		cpu: 0.88,
		trend: rising,
	},
	{
		name: "orders-worker",
		project: "acme-prod",
		region: "us-central1",
		requests: 310_000,
		c4xx: 12_400,
		c5xx: 1_920,
		p95: 1.05,
		instances: 2,
		cpu: 0.34,
		trend: bump(18),
	},
	{
		name: "web-frontend",
		project: "acme-prod",
		region: "us-central1",
		requests: 2_100_000,
		c4xx: 42_000,
		c5xx: 210,
		p95: 0.096,
		instances: 8,
		cpu: 0.22,
		trend: wave,
	},
	{
		name: "auth",
		project: "acme-prod",
		region: "us-central1",
		requests: 190_000,
		c4xx: 11_400,
		c5xx: 0,
		p95: 0.041,
		instances: 1,
		cpu: 0.09,
		trend: wave,
	},
	{
		name: "pricing",
		project: "acme-staging",
		region: "us-central1",
		requests: 21_000,
		c4xx: 300,
		c5xx: 4,
		p95: 0.12,
		instances: 1,
		cpu: 0.05,
		trend: flat,
	},
	{
		name: "legacy-export",
		project: "acme-staging",
		region: "us-central1",
		requests: 0,
		c4xx: 0,
		c5xx: 0,
		instances: 1,
		cpu: 0.01,
		billable: 43_200,
		trend: flat,
	},
	{
		name: "report-cron",
		project: "acme-staging",
		region: "us-central1",
		requests: 0,
		c4xx: 0,
		c5xx: 0,
		instances: 1,
		cpu: 0.01,
		billable: 43_200,
		trend: flat,
	},
]

const runPoints = (service: Service): ReadonlyArray<GcpMetricPoint> => {
	const keys = [service.name, service.project, service.region]
	return [
		point(keys, `${RUN}.requests`, "2xx", service.requests - service.c4xx - service.c5xx),
		point(keys, `${RUN}.requests`, "4xx", service.c4xx),
		point(keys, `${RUN}.requests`, "5xx", service.c5xx),
		...(service.p95 === undefined ? [] : [gauge(keys, `${RUN}.request.duration`, "0.95", service.p95)]),
		gauge(keys, `${RUN}.container.instance.count`, "active", service.instances),
		...(service.cpu === undefined
			? []
			: [gauge(keys, `${RUN}.container.cpu.utilization`, "0.95", service.cpu)]),
		point(keys, `${RUN}.container.billable_time`, "", service.billable ?? service.instances * 43_200),
	]
}

const IMAGE_RESIZE = ["image-resize", "acme-data", "europe-west1"]
const functionPoints: ReadonlyArray<GcpMetricPoint> = [
	point(IMAGE_RESIZE, `${FUNCTION}.executions`, "ok", 38_650),
	point(IMAGE_RESIZE, `${FUNCTION}.executions`, "crash", 2_900),
	point(IMAGE_RESIZE, `${FUNCTION}.executions`, "timeout", 550),
	gauge(IMAGE_RESIZE, `${FUNCTION}.execution.duration`, "0.95", 6.2),
	gauge(IMAGE_RESIZE, `${FUNCTION}.instance.count`, "active", 4),
	gauge(IMAGE_RESIZE, `${FUNCTION}.memory.usage`, "0.95", 233 * 1024 * 1024),
]

interface Subscription {
	readonly name: string
	readonly project: string
	readonly delivered: number
	/** The backlog at the first and the last bucket. */
	readonly backlog: readonly [number, number]
	readonly oldestSeconds: number
	readonly push?: { readonly ack: number; readonly failed: number }
	readonly deadLettered: number
	readonly trend: (bucket: number) => number
}

const SUBSCRIPTIONS: ReadonlyArray<Subscription> = [
	{
		name: "orders-fulfil",
		project: "acme-prod",
		delivered: 210_000,
		backlog: [2_000, 48_200],
		oldestSeconds: 2_280,
		push: { ack: 9_590, failed: 410 },
		deadLettered: 212,
		trend: (b) => 1.3 - b / 40,
	},
	{
		name: "email-send",
		project: "acme-prod",
		delivered: 88_000,
		backlog: [800, 12_900],
		oldestSeconds: 840,
		deadLettered: 0,
		trend: (b) => (b > 14 ? 0.7 : 1.1),
	},
	{
		name: "analytics-ingest",
		project: "acme-data",
		delivered: 920_000,
		backlog: [3_050, 3_100],
		oldestSeconds: 660,
		deadLettered: 0,
		trend: wave,
	},
	{
		name: "invoices-webhook",
		project: "acme-prod",
		delivered: 12_000,
		backlog: [6, 4],
		oldestSeconds: 3,
		push: { ack: 11_988, failed: 12 },
		deadLettered: 0,
		trend: wave,
	},
]

const subscriptionPoints = (sub: Subscription): ReadonlyArray<GcpMetricPoint> => {
	const keys = [sub.name, sub.project]
	return [
		point(keys, `${SUB}.sent_messages`, "", sub.delivered),
		gauge(keys, `${SUB}.undelivered_messages`, "", (sub.backlog[0] + sub.backlog[1]) / 2),
		gauge(keys, `${SUB}.oldest_unacked_message.age`, "", sub.oldestSeconds),
		point(keys, `${SUB}.dead_lettered_messages`, "", sub.deadLettered),
		...(sub.push === undefined
			? []
			: [
					point(keys, `${SUB}.push_requests`, "ack", sub.push.ack),
					point(keys, `${SUB}.push_requests`, "remote_server_5xx", sub.push.failed),
				]),
	]
}

interface Database {
	readonly name: string
	readonly project: string
	readonly region: string
	readonly cpu: number
	readonly memory: number
	readonly disk: number
	readonly connections: number
	readonly idleInTransaction?: number
	/** Query Insights: queries in the window and their p95 in seconds. */
	readonly queries?: number
	readonly p95?: number
	readonly slowQueries?: number
	readonly lag?: number
	readonly trend?: (bucket: number) => number
}

const DATABASES: ReadonlyArray<Database> = [
	{
		name: "orders-db",
		project: "acme-prod",
		region: "us-central1",
		cpu: 0.62,
		memory: 0.78,
		disk: 0.71,
		connections: 97,
		idleInTransaction: 38,
		queries: 29_100_000,
		p95: 0.34,
		trend: bump(16),
	},
	{
		name: "orders-db-replica-1",
		project: "acme-prod",
		region: "us-central1",
		cpu: 0.18,
		memory: 0.52,
		disk: 0.71,
		connections: 12,
		lag: 4,
	},
	{
		name: "analytics-pg",
		project: "acme-data",
		region: "us-central1",
		cpu: 0.41,
		memory: 0.55,
		disk: 0.88,
		connections: 14,
		queries: 1_200_000,
		p95: 2.4,
		trend: (bucket) => bump(5)(bucket) + bump(18)(bucket) - 1,
	},
	{
		name: "users-mysql",
		project: "acme-prod",
		region: "europe-west1",
		cpu: 0.23,
		memory: 0.64,
		disk: 0.34,
		connections: 41,
		slowQueries: 12,
	},
	{
		name: "staging-pg",
		project: "acme-staging",
		region: "us-central1",
		cpu: 0.04,
		memory: 0.38,
		disk: 0.12,
		connections: 3,
	},
]

const databasePoints = (db: Database): ReadonlyArray<GcpMetricPoint> => {
	const keys = [`${db.project}:${db.name}`, db.project, db.region]
	return [
		gauge(keys, `${SQL}.cpu.utilization`, "", db.cpu),
		gauge(keys, `${SQL}.memory.utilization`, "", db.memory),
		gauge(keys, `${SQL}.disk.utilization`, "", db.disk),
		gauge(keys, `${SQL}.connection.count`, "", db.connections),
		...(db.idleInTransaction === undefined
			? []
			: [
					gauge(
						keys,
						`${SQL}.postgresql.connection.count`,
						"idle_in_transaction",
						db.idleInTransaction,
					),
				]),
		...(db.queries === undefined ? [] : [point(keys, `${SQL}.queries`, "", db.queries)]),
		...(db.p95 === undefined ? [] : [gauge(keys, `${SQL}.query.duration`, "0.95", db.p95)]),
		...(db.slowQueries === undefined
			? []
			: [point(keys, `${SQL}.mysql.slow_queries`, "", db.slowQueries)]),
		...(db.lag === undefined ? [] : [gauge(keys, `${SQL}.replication.lag`, "", db.lag)]),
	]
}

const instance = (
	db: Pick<Database, "name" | "project">,
	settings: Partial<GcpCloudSqlInstance>,
): GcpCloudSqlInstance => ({
	id: `${db.project}:${db.name}`,
	name: db.name,
	databaseVersion: "POSTGRES_15",
	edition: "ENTERPRISE",
	tier: null,
	cpus: null,
	memoryGb: null,
	availabilityType: "ZONAL",
	primary: null,
	diskSizeGb: 100,
	queryInsightsEnabled: true,
	maxConnections: null,
	maxConnectionsSource: null,
	...settings,
})

const [ORDERS, REPLICA, ANALYTICS, USERS, STAGING] = DATABASES

export const CLOUD_SQL_INSTANCES: ReadonlyArray<GcpCloudSqlInstance> = [
	instance(ORDERS, {
		tier: "db-custom-4-16384",
		cpus: 4,
		memoryGb: 16,
		availabilityType: "REGIONAL",
		maxConnections: 100,
		maxConnectionsSource: "default",
	}),
	instance(REPLICA, {
		tier: "db-custom-4-16384",
		cpus: 4,
		memoryGb: 16,
		primary: "acme-prod:orders-db",
		maxConnections: 100,
		maxConnectionsSource: "default",
	}),
	instance(ANALYTICS, {
		databaseVersion: "POSTGRES_14",
		tier: "db-custom-8-32768",
		cpus: 8,
		memoryGb: 32,
		maxConnections: 200,
		maxConnectionsSource: "flag",
	}),
	instance(USERS, { databaseVersion: "MYSQL_8_0", tier: "db-custom-2-8192", cpus: 2, memoryGb: 8 }),
	instance(STAGING, {
		databaseVersion: "POSTGRES_16",
		tier: "db-f1-micro",
		memoryGb: 0.6,
		queryInsightsEnabled: false,
		maxConnections: 25,
		maxConnectionsSource: "default",
	}),
]

export const FLEET: ReadonlyArray<GcpFleetRead> = [
	{ service: "cloudRun", points: SERVICES.flatMap(runPoints), failed: false },
	{ service: "cloudFunctions", points: functionPoints, failed: false },
	{ service: "pubsub", points: SUBSCRIPTIONS.flatMap(subscriptionPoints), failed: false },
	{ service: "cloudSql", points: DATABASES.flatMap(databasePoints), failed: false },
]

const bucketTime = (bucket: number) => new Date(START_MS + bucket * BUCKET_SECONDS * 1000).toISOString()

/** Spreads a window's total over the buckets in the form of `trend`. */
const series = (
	keys: ReadonlyArray<string>,
	metric: string,
	total: number,
	trend: (bucket: number) => number,
): ReadonlyArray<GcpSparklinePoint> => {
	const weights = Array.from({ length: BUCKETS }, (_, bucket) => trend(bucket))
	const sum = weights.reduce((a, b) => a + b, 0)
	return weights.map((weight, bucket) => ({
		keys,
		bucket: bucketTime(bucket),
		metric,
		total: Math.round((total * weight) / sum),
		samples: 30,
	}))
}

/** A gauge from its first to its last bucket, the rise backloaded like a stalled consumer's. */
const backlog = (keys: ReadonlyArray<string>, [first, last]: readonly [number, number]) =>
	Array.from({ length: BUCKETS }, (_, bucket): GcpSparklinePoint => ({
		keys,
		bucket: bucketTime(bucket),
		metric: `${SUB}.undelivered_messages`,
		total: (first + (last - first) * (bucket / (BUCKETS - 1)) ** 2) * 30,
		samples: 30,
	}))

export const SPARKLINE_READS: ReadonlyArray<{
	readonly service: GcpInfraServiceId
	readonly points: ReadonlyArray<GcpSparklinePoint>
}> = [
	{
		service: "cloudRun",
		points: SERVICES.flatMap((s) =>
			series([s.name, s.project, s.region], `${RUN}.requests`, s.requests, s.trend),
		),
	},
	{ service: "cloudFunctions", points: series(IMAGE_RESIZE, `${FUNCTION}.executions`, 42_100, wave) },
	{
		service: "pubsub",
		points: SUBSCRIPTIONS.flatMap((s) => [
			...series([s.name, s.project], `${SUB}.sent_messages`, s.delivered, s.trend),
			...backlog([s.name, s.project], s.backlog),
		]),
	},
	{
		service: "cloudSql",
		points: DATABASES.flatMap((db) =>
			db.queries === undefined || db.trend === undefined
				? []
				: series(
						[`${db.project}:${db.name}`, db.project, db.region],
						`${SQL}.queries`,
						db.queries,
						db.trend,
					),
		),
	},
]

export const PROJECT_HEALTH: ReadonlyMap<string, GcpProjectHealth> = new Map([
	["acme-prod", { tone: "ok", message: "metrics receiving" }],
	["acme-data", { tone: "warn", message: "metrics incomplete" }],
])

export const VIEWS = ["services", "pubsub", "cloudSql"] as const satisfies ReadonlyArray<GcpView>
export const VIEW_LABEL = { services: "Services", pubsub: "Pub/Sub", cloudSql: "Cloud SQL" } as const
