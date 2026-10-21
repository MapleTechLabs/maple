// The Google Cloud workload lab's fixtures, shared with apps/web's `/lab/gcp-workload`.
// Imports stay relative: the Foldkit typecheck resolves `@/` to its own source.

import { Schema } from "effect"

import type { GcpInfraServiceId } from "@maple/domain/gcp-infra"
import { GcpProjectId } from "@maple/domain/primitives"
import type { GcpResource } from "@maple/domain/http"

import type { GcpBucketPoint } from "../components/infra/gcp/charts"
import type { GcpStatement, GcpTracedQuery } from "../components/infra/gcp/cloud-sql-signals"
import type { StatementSpan } from "../page/infra-integrations/gcp/data"
import type { GcpCloudSqlInstance } from "../components/infra/gcp/inventory"
import { GCP_IDLE_IN_TRANSACTION, type GcpReplica } from "../components/infra/gcp/list-model"

/** Six hours of five-minute buckets, as `chartBucketSeconds` picks them for that window. */
export const BUCKET_SECONDS = 300
const BUCKETS = 72
const START_MS = Date.parse("2026-10-14T09:00:00.000Z")
export const RANGE = {
	startTime: "2026-10-14 09:00:00",
	endTime: "2026-10-14 15:00:00",
	bucketSeconds: BUCKET_SECONDS,
}
/** A gauge is five one-minute points a bucket. */
const SAMPLES = 5

const bucketAt = (index: number) => new Date(START_MS + index * BUCKET_SECONDS * 1000).toISOString()

const counter = (index: number, metric: string, label: string, total: number): GcpBucketPoint => ({
	bucket: bucketAt(index),
	metric,
	label,
	total: Math.round(total),
	samples: 1,
})

const gauge = (index: number, metric: string, label: string, value: number): GcpBucketPoint => ({
	bucket: bucketAt(index),
	metric,
	label,
	total: value * SAMPLES,
	samples: SAMPLES,
})

/** Traffic that climbs through the morning: 0 at the window's start, 1 at its end. */
const ramp = (index: number) => index / (BUCKETS - 1)
/** The 5xx burst: buckets 52-57, 13:20 to 13:50, while every instance is busy. */
const inBurst = (index: number) => index >= 52 && index <= 57

const RUN = "gcp.cloud_run"

const CHECKOUT_API: ReadonlyArray<GcpBucketPoint> = Array.from({ length: BUCKETS }, (_, index) => {
	const busy = inBurst(index)
	const active = busy ? 20 : Math.min(19, 6 + Math.round(12 * ramp(index)))
	const p95 = busy ? 1.84 : 0.38 + 0.08 * ramp(index)
	return [
		counter(index, `${RUN}.requests`, "2xx", 13_000 + 7_000 * ramp(index)),
		counter(index, `${RUN}.requests`, "4xx", 360 + 40 * Math.sin(index)),
		// Cloud Run's own 503s while no instance is free; a stray one now and then otherwise.
		counter(index, `${RUN}.requests`, "5xx", busy ? 6_850 : index % 9 === 0 ? 3 : 0),
		gauge(index, `${RUN}.container.instance.count`, "active", active),
		gauge(index, `${RUN}.container.instance.count`, "idle", busy ? 0 : 2),
		gauge(index, `${RUN}.request.duration`, "0.5", 0.21),
		gauge(index, `${RUN}.request.duration`, "0.95", p95),
		gauge(index, `${RUN}.request.duration`, "0.99", p95 * 1.4),
		gauge(index, `${RUN}.container.cpu.utilization`, "0.5", 0.48),
		gauge(index, `${RUN}.container.cpu.utilization`, "0.95", busy ? 0.93 : 0.66),
		gauge(index, `${RUN}.container.cpu.utilization`, "0.99", busy ? 0.97 : 0.74),
		gauge(index, `${RUN}.container.memory.utilization`, "0.5", 0.52),
		gauge(index, `${RUN}.container.memory.utilization`, "0.95", 0.64),
		gauge(index, `${RUN}.container.memory.utilization`, "0.99", 0.69),
		gauge(index, `${RUN}.container.request.max_concurrency`, "0.5", busy ? 80 : 22),
		gauge(index, `${RUN}.container.request.max_concurrency`, "0.95", busy ? 80 : 41),
		gauge(index, `${RUN}.container.request.max_concurrency`, "0.99", busy ? 80 : 55),
		counter(index, `${RUN}.container.billable_time`, "", active * BUCKET_SECONDS),
	]
}).flat()

const SQL = "gcp.cloud_sql"

const GIB = 1024 ** 3

/** The pool runs dry in the burst: every connection taken, many of them idle in a transaction. */
const ORDERS_DB: ReadonlyArray<GcpBucketPoint> = Array.from({ length: BUCKETS }, (_, index) => {
	const busy = inBurst(index)
	const open = busy ? 97 : 58 + Math.round(30 * ramp(index))
	const idleInTransaction = busy ? 38 : 4
	const queries = 380_000 + 120_000 * ramp(index)
	// Execution time in seconds: locks take a third of it in the burst.
	const executed = busy ? 9_000 : 5_200 + 1_400 * ramp(index)
	return [
		gauge(index, `${SQL}.cpu.utilization`, "", busy ? 0.71 : 0.42 + 0.2 * ramp(index)),
		gauge(index, `${SQL}.memory.utilization`, "", 0.76 + 0.02 * ramp(index)),
		gauge(index, `${SQL}.disk.utilization`, "", 0.709 + 0.002 * ramp(index)),
		gauge(index, `${SQL}.disk.usage`, "", (354 + ramp(index)) * GIB),
		gauge(index, `${SQL}.disk.limit`, "", 500 * GIB),
		gauge(index, `${SQL}.connection.count`, "", open),
		gauge(index, `${SQL}.postgresql.connection.count`, "active", open - idleInTransaction - 10),
		gauge(index, `${SQL}.postgresql.connection.count`, "idle", 10),
		gauge(index, `${SQL}.postgresql.connection.count`, GCP_IDLE_IN_TRANSACTION, idleInTransaction),
		gauge(index, `${SQL}.postgresql.transaction_id.utilization`, "", 0.18),
		counter(index, `${SQL}.postgresql.block_reads`, "buffer_cache", 9_920_000),
		counter(index, `${SQL}.postgresql.block_reads`, "disk", 80_000),
		counter(index, `${SQL}.postgresql.temp_file.io`, "write", 0.02 * GIB),
		counter(index, `${SQL}.queries`, "", queries),
		gauge(index, `${SQL}.query.duration`, "0.5", 0.009),
		gauge(index, `${SQL}.query.duration`, "0.95", busy ? 0.62 : 0.3 + 0.04 * ramp(index)),
		gauge(index, `${SQL}.query.duration`, "0.99", busy ? 1.4 : 0.6),
		counter(index, `${SQL}.query.execution.time`, "", executed),
		counter(index, `${SQL}.query.lock.time`, "", executed * (busy ? 0.31 : 0.05)),
		counter(index, `${SQL}.query.io.time`, "", executed * 0.04),
		counter(index, `${SQL}.disk.operations`, "read", 42_000 + 9_000 * ramp(index)),
		counter(index, `${SQL}.disk.operations`, "write", 18_000 + 4_000 * ramp(index)),
	]
}).flat()

const statement = (
	queryHash: string,
	querystring: string,
	figures: {
		calls: number
		p95: number
		rowsPerCall: number
		lockShare: number
		executionShare: number
	},
): GcpStatement => ({
	queryHash,
	querystring,
	calls: figures.calls,
	p50LatencyMillis: figures.p95 / 4,
	p95LatencyMillis: figures.p95,
	totalExecutionMillis: figures.executionShare * 4_600_000_000,
	executionShare: figures.executionShare,
	rows: figures.calls * figures.rowsPerCall,
	lockShare: figures.lockShare,
	ioShare: 0.04,
})

// What Query Insights recorded for orders-db: the inventory lock waits on itself, the order update
// the app waits on for a connection, a report nobody traces.
const ORDERS_DB_STATEMENTS: ReadonlyArray<GcpStatement> = [
	statement("q1", "SELECT id, sku, quantity FROM inventory WHERE sku = $1 FOR UPDATE", {
		calls: 880_000,
		p95: 290,
		rowsPerCall: 1,
		lockShare: 0.72,
		executionShare: 0.41,
	}),
	statement("q2", "UPDATE orders SET status = $1, updated_at = $2 WHERE id = $3", {
		calls: 2_100_000,
		p95: 38,
		rowsPerCall: 1,
		lockShare: 0.24,
		executionShare: 0.22,
	}),
	statement("q3", "SELECT count(*) FROM orders WHERE created_at > $1", {
		calls: 1_200,
		p95: 2_800,
		rowsPerCall: 4_100_000,
		lockShare: 0,
		executionShare: 0.14,
	}),
	statement("q4", "SELECT id, order_id, sku, quantity, price FROM order_items WHERE order_id = ANY($1)", {
		calls: 6_800_000,
		p95: 12,
		rowsPerCall: 18,
		lockShare: 0.02,
		executionShare: 0.11,
	}),
	statement("q5", "INSERT INTO order_events (order_id, kind, payload) VALUES ($1, $2, $3)", {
		calls: 4_300_000,
		p95: 6,
		rowsPerCall: 1,
		lockShare: 0.01,
		executionShare: 0.06,
	}),
	statement("q6", "SELECT * FROM customers WHERE id = $1", {
		calls: 3_900_000,
		p95: 3,
		rowsPerCall: 1,
		lockShare: 0,
		executionShare: 0.03,
	}),
]

const tracedQuery = (
	sampleStatement: string,
	sampleService: string,
	p95DurationMs: number,
	serviceCount = 1,
) => ({
	queryKey: `shape-${sampleService}-${sampleStatement.length}`,
	sampleStatement,
	sampleService,
	serviceCount,
	estimatedQueryCount: 100_000,
	p95DurationMs,
})

/** The same statements as the client spans recorded them, literals and all. */
const ORDERS_DB_TRACED_QUERIES = [
	tracedQuery(
		"SELECT id, sku, quantity FROM inventory WHERE sku = 'SKU-4471' FOR UPDATE",
		"checkout-api",
		1_900,
	),
	tracedQuery(
		"UPDATE orders SET status = 'paid', updated_at = '2026-10-14 13:21:07' WHERE id = 81723",
		"checkout-api",
		1_640,
		2,
	),
	tracedQuery("UPDATE orders SET status = $1, updated_at = $2 WHERE id = $3", "orders-worker", 52),
	tracedQuery(
		"SELECT id, order_id, sku, quantity, price FROM order_items WHERE order_id = ANY($1)",
		"checkout-api",
		410,
		2,
	),
	tracedQuery("INSERT INTO order_events (order_id, kind, payload) VALUES ($1, $2, $3)", "orders-worker", 9),
	tracedQuery("SELECT * FROM customers WHERE id = $1", "web-frontend", 5),
]

const ORDERS_DB_INSTANCE: GcpCloudSqlInstance = {
	id: "acme-prod:orders-db",
	name: "orders-db",
	databaseVersion: "POSTGRES_15",
	edition: "ENTERPRISE",
	tier: "db-custom-4-16384",
	cpus: 4,
	memoryGb: 16,
	availabilityType: "REGIONAL",
	primary: null,
	diskSizeGb: 500,
	queryInsightsEnabled: true,
	maxConnections: 100,
	maxConnectionsSource: "default",
}

const SPAN_SERVICES = ["checkout-api", "orders-worker"]

/** A statement's five slowest calls: its traced p95 stretched into a tail, one call in a few minutes. */
export const labStatementSpans = (
	queryHash: string,
	p95Ms: number,
	services: ReadonlyArray<string>,
): ReadonlyArray<StatementSpan> =>
	[4.4, 3.1, 2.3, 1.7, 1.4].map((factor, index) => ({
		traceId: `${queryHash}${String(index).padStart(30, "0")}`,
		spanId: `${queryHash}${String(index).padStart(14, "0")}`,
		serviceName: (services.length === 0 ? SPAN_SERVICES : services)[index % 2] ?? services[0] ?? "",
		timestamp: new Date(
			START_MS + (BUCKETS * BUCKET_SECONDS - (index * 37 + 11) * 60) * 1000,
		).toISOString(),
		durationMs: Math.round(p95Ms * factor),
	}))

/** What a Cloud SQL page reads besides its metrics. */
export interface LabCloudSql {
	readonly instance: GcpCloudSqlInstance
	readonly statements: ReadonlyArray<GcpStatement>
	readonly tracedQueries: ReadonlyArray<GcpTracedQuery>
	readonly databases: ReadonlyArray<string>
	readonly services: number
	readonly replicas: ReadonlyArray<GcpReplica>
}

export interface LabWorkload {
	readonly service: GcpInfraServiceId
	readonly keys: ReadonlyArray<string>
	readonly points: ReadonlyArray<GcpBucketPoint>
	readonly resource: GcpResource
	/** Errors on the traced service's entry spans; null when nothing of this name sends spans. */
	readonly tracedErrors: number | null
	readonly cloudSql?: LabCloudSql
}

export const WORKLOADS = {
	run: {
		service: "cloudRun",
		keys: ["checkout-api", "acme-prod", "us-central1"],
		points: CHECKOUT_API,
		resource: {
			name: "//run.googleapis.com/projects/acme-prod/locations/us-central1/services/checkout-api",
			assetType: "run.googleapis.com/Service",
			projectId: Schema.decodeSync(GcpProjectId)("acme-prod"),
			location: "us-central1",
			displayName: null,
			state: null,
			labels: { team: "payments", env: "prod" },
			details: null,
		},
		tracedErrors: 3_200,
	},
	sql: {
		service: "cloudSql",
		keys: ["acme-prod:orders-db", "acme-prod", "us-central1"],
		points: ORDERS_DB,
		resource: {
			name: "//cloudsql.googleapis.com/projects/acme-prod/instances/orders-db",
			assetType: "sqladmin.googleapis.com/Instance",
			projectId: Schema.decodeSync(GcpProjectId)("acme-prod"),
			location: "us-central1",
			displayName: null,
			state: "RUNNABLE",
			labels: { team: "payments" },
			details: ORDERS_DB_INSTANCE,
		},
		tracedErrors: null,
		cloudSql: {
			instance: ORDERS_DB_INSTANCE,
			statements: ORDERS_DB_STATEMENTS,
			tracedQueries: ORDERS_DB_TRACED_QUERIES,
			databases: ["orders", "orders_audit"],
			services: 4,
			replicas: [{ name: "orders-db-replica-1", lagSeconds: 4 }],
		},
	},
} satisfies Record<"run" | "sql", LabWorkload>

export const PAGES = ["run", "sql"] as const
export type LabPage = (typeof PAGES)[number]
export const PAGE_LABEL = {
	run: "Cloud Run · checkout-api",
	sql: "Cloud SQL · orders-db",
} satisfies Record<LabPage, string>
