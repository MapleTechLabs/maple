import { describe, expect, it } from "vitest"

import type { GcpBucketPoint } from "./charts"
import type { GcpCloudSqlInstance } from "./inventory"
import {
	gcpAppWait,
	gcpCloudSqlHealth,
	gcpCloudSqlView,
	gcpConnectionPeak,
	gcpMatchStatements,
	gcpStatementTextPrefix,
	gcpNormalizeStatement,
	gcpPoolFull,
	gcpQueryInsightsUnavailable,
	gcpSqlEngine,
	gcpSqlSize,
	gcpStatements,
	type GcpTracedQuery,
} from "./cloud-sql-signals"

const BUCKET_SECONDS = 300
const START_MS = Date.parse("2026-10-14T12:00:00.000Z")
const at = (index: number) => new Date(START_MS + index * BUCKET_SECONDS * 1000).toISOString()
const point = (index: number, metric: string, label: string, total: number, samples = 1): GcpBucketPoint => ({
	bucket: at(index),
	metric,
	label,
	total,
	samples,
})

const DB = "gcp.cloud_sql"

const tracedQuery = (statement: string, service: string, p95: number, calls = 1000): GcpTracedQuery => ({
	queryKey: `key-${service}-${p95}`,
	sampleStatement: statement,
	sampleService: service,
	serviceCount: 1,
	estimatedQueryCount: calls,
	p95DurationMs: p95,
})

const insight = (queryHash: string, querystring: string, p95LatencyMillis: number | null) => ({
	queryHash,
	querystring,
	p95LatencyMillis,
})

const INSTANCE: GcpCloudSqlInstance = {
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

describe("gcpNormalizeStatement", () => {
	it("reads Query Insights' placeholders and a span's literals as the same statement", () => {
		expect(gcpNormalizeStatement("UPDATE orders SET status = $1, updated_at = $2 WHERE id = $3")).toBe(
			gcpNormalizeStatement("update orders set status='paid', updated_at = '2026-10-14' where id=42;"),
		)
	})

	it("reads a driver's ? and an IN list of any length alike", () => {
		expect(gcpNormalizeStatement("SELECT * FROM items WHERE id IN (?, ?, ?)")).toBe(
			gcpNormalizeStatement("select *\n  from items where id in ($1)"),
		)
	})

	it("keeps digits that are part of a name", () => {
		expect(gcpNormalizeStatement("SELECT * FROM table1")).toBe("select * from table1")
	})

	it("tells different statements apart", () => {
		expect(gcpNormalizeStatement("SELECT * FROM orders WHERE id = $1")).not.toBe(
			gcpNormalizeStatement("SELECT * FROM order_items WHERE id = $1"),
		)
	})
})

describe("gcpMatchStatements", () => {
	const rows = [
		insight("a", "UPDATE orders SET status = $1 WHERE id = $2", 38),
		insight("b", "SELECT count(*) FROM orders WHERE created_at > $1", 2800),
	]

	it("joins a statement to the traced shapes of it, the busiest first", () => {
		const traced = gcpMatchStatements(rows, [
			tracedQuery("update orders set status = 'paid' where id = 7", "orders-worker", 90, 200),
			tracedQuery("UPDATE orders SET status = ? WHERE id = ?", "checkout-api", 1640, 5000),
		])
		expect(traced.get("a")).toEqual({
			services: ["checkout-api", "orders-worker"],
			serviceCount: 2,
			appP95Ms: 1640,
			queryKeys: ["key-checkout-api-1640", "key-orders-worker-90"],
		})
	})

	it("leaves a statement no shape matches untraced", () => {
		const traced = gcpMatchStatements(rows, [tracedQuery("SELECT 1", "checkout-api", 1)])
		expect(traced.has("b")).toBe(false)
	})

	it("ignores shapes without a statement", () => {
		expect(gcpMatchStatements([insight("c", "", 1)], [tracedQuery("", "redis-user", 1)]).size).toBe(0)
	})
})

describe("gcpStatementTextPrefix", () => {
	it("keeps the first line before the first placeholder, as the span's text has it", () => {
		expect(gcpStatementTextPrefix("SELECT id, status FROM orders\n  WHERE org_id = $1 AND id = $2")).toBe(
			"SELECT id, status FROM orders",
		)
		expect(gcpStatementTextPrefix("UPDATE orders SET status = $1 WHERE id = $2")).toBe(
			"UPDATE orders SET status =",
		)
	})

	it("caps a long statement so the link stays short", () => {
		expect(gcpStatementTextPrefix(`SELECT ${"a, ".repeat(200)}b FROM t`)?.length).toBe(200)
	})

	it("keeps a statement without placeholders whole", () => {
		expect(gcpStatementTextPrefix("SELECT count(*) FROM order_events")).toBe(
			"SELECT count(*) FROM order_events",
		)
	})

	it("gives none when the text before the placeholder is too short to tell statements apart", () => {
		expect(gcpStatementTextPrefix("SELECT $1")).toBeNull()
	})
})

describe("gcpAppWait", () => {
	const traced = (appP95Ms: number) =>
		new Map([["a", { services: ["checkout-api"], serviceCount: 1, appP95Ms, queryKeys: [] }]])

	it("calls out an app side five times the database's and 200ms more", () => {
		expect(gcpAppWait([insight("a", "UPDATE orders", 38)], traced(1640))).toEqual({
			service: "checkout-api",
			statement: "UPDATE orders",
			appP95Ms: 1640,
			dbP95Ms: 38,
		})
	})

	it("stays quiet under five times the database's p95", () => {
		expect(gcpAppWait([insight("a", "UPDATE orders", 400)], traced(1640))).toBeNull()
	})

	it("stays quiet when the gap is under 200ms", () => {
		expect(gcpAppWait([insight("a", "SELECT 1", 2)], traced(150))).toBeNull()
	})

	it("picks the statement the app waits on the most times longer than the database runs it", () => {
		const statements = [insight("a", "wider gap", 290), insight("b", "most times", 38)]
		const both = new Map([
			["a", { services: ["checkout-api"], serviceCount: 1, appP95Ms: 1900, queryKeys: [] }],
			["b", { services: ["checkout-api"], serviceCount: 1, appP95Ms: 1640, queryKeys: [] }],
		])
		expect(gcpAppWait(statements, both)?.statement).toBe("most times")
	})
})

describe("connections", () => {
	const points = [
		point(0, `${DB}.connection.count`, "", 60),
		point(1, `${DB}.connection.count`, "", 97),
		point(1, `${DB}.postgresql.connection.count`, "idle_in_transaction", 38),
		point(2, `${DB}.connection.count`, "", 70),
	]

	it("finds the busiest bucket and the idle-in-transaction connections in it", () => {
		expect(gcpConnectionPeak(points, BUCKET_SECONDS, 100)).toEqual({
			open: 97,
			idleInTransaction: 38,
			max: 100,
		})
	})

	it("calls the pool full from 90% of max_connections, never without a max", () => {
		expect(gcpPoolFull(gcpConnectionPeak(points, BUCKET_SECONDS, 100))).toBe(true)
		expect(gcpPoolFull(gcpConnectionPeak(points, BUCKET_SECONDS, 200))).toBe(false)
		expect(gcpPoolFull(gcpConnectionPeak(points, BUCKET_SECONDS, null))).toBe(false)
	})
})

describe("gcpCloudSqlHealth", () => {
	it("reads PostgreSQL's cache hits, transaction IDs and spills, a missing deadlock count as none", () => {
		const points = [
			point(0, `${DB}.postgresql.block_reads`, "buffer_cache", 992),
			point(0, `${DB}.postgresql.block_reads`, "disk", 8),
			point(0, `${DB}.postgresql.transaction_id.utilization`, "", 0.18),
			point(0, `${DB}.postgresql.temp_file.io`, "write", 1.5 * 1024 ** 3),
		]
		expect(gcpCloudSqlHealth(points)).toEqual([
			{ label: "deadlocks", value: "0" },
			{ label: "transaction IDs", value: "18% used", tone: "ok" },
			{ label: "cache hit", value: "99.2%", tone: "ok" },
			{ label: "temp spill", value: "1.5 GB" },
		])
	})

	it("says nothing for a MySQL instance", () => {
		expect(gcpCloudSqlHealth([point(0, `${DB}.cpu.utilization`, "", 0.4)])).toEqual([])
	})
})

describe("the instance in words", () => {
	it("names the engine and version", () => {
		expect(gcpSqlEngine("POSTGRES_15")).toBe("Postgres 15")
		expect(gcpSqlEngine("MYSQL_8_0")).toBe("MySQL 8.0")
		expect(gcpSqlEngine("SQLSERVER_2022_STANDARD")).toBe("SQL Server 2022 standard")
	})

	it("sizes a tier, a shared core without vCPUs", () => {
		expect(gcpSqlSize(INSTANCE)).toBe("4 vCPU, 16 GB")
		expect(gcpSqlSize({ ...INSTANCE, cpus: null, memoryGb: 0.6 })).toBe("shared core")
		expect(gcpSqlSize({ ...INSTANCE, tier: "db-unknown", cpus: null, memoryGb: null })).toBe("db-unknown")
	})
})

describe("gcpCloudSqlView", () => {
	it("puts the inventory, databases and replicas in the rail before the disk", () => {
		const view = gcpCloudSqlView({
			instance: INSTANCE,
			statements: [],
			tracedQueries: [],
			databases: ["orders", "orders_audit"],
			replicas: [{ name: "orders-db-replica-1", lagSeconds: 4 }],
			points: [
				point(0, `${DB}.disk.usage`, "", 355 * 1024 ** 3),
				point(0, `${DB}.disk.limit`, "", 500 * 1024 ** 3),
			],
			bucketSeconds: BUCKET_SECONDS,
		})
		expect(view.facts).toEqual([
			{ label: "engine", value: "Postgres 15 · Enterprise" },
			{ label: "databases", value: "orders · orders_audit" },
			{ label: "read replica", value: "orders-db-replica-1" },
			{ label: "replica lag", value: "4.00s" },
			{ label: "disk", value: "355 of 500 GB", tone: "warn" },
		])
	})

	it("focuses the service map on the caller of the busiest traced statement", () => {
		const view = gcpCloudSqlView({
			instance: INSTANCE,
			statements: [
				{
					queryHash: "a",
					querystring: "SELECT 1",
					calls: 10,
					p50LatencyMillis: 1,
					p95LatencyMillis: 2,
					totalExecutionMillis: 20,
					executionShare: 1,
					rows: 10,
					lockShare: 0,
					ioShare: 0,
				},
			],
			tracedQueries: [tracedQuery("select 1", "checkout-api", 3)],
			databases: undefined,
			replicas: [],
			points: [],
			bucketSeconds: BUCKET_SECONDS,
		})
		expect(view.focusService).toBe("checkout-api")
		expect(view.wait).toBeNull()
	})
})

describe("gcpStatements", () => {
	const row = (queryHash: string, executionSeconds: number, calls = 40) => ({
		queryHash,
		statement: `SELECT ${queryHash}`,
		calls,
		executionSeconds,
		lockSeconds: executionSeconds / 4,
		ioSeconds: executionSeconds / 2,
		rowCount: 800,
		p50Seconds: 0.002,
		p95Seconds: 0.05,
	})

	it("shares each statement's time of the instance's, and its waits of its own", () => {
		const [orders] = gcpStatements(
			[row("a", 30), row("b", 10)],
			[point(0, `${DB}.query.execution.time`, "", 60), point(1, `${DB}.query.execution.time`, "", 40)],
		)
		expect(orders).toMatchObject({
			querystring: "SELECT a",
			executionShare: 0.3,
			lockShare: 0.25,
			ioShare: 0.5,
			totalExecutionMillis: 30_000,
			p95LatencyMillis: 50,
			rows: 800,
		})
	})

	it("never shares of less than the statements' own time, and has no latency without calls", () => {
		const statements = gcpStatements([row("a", 3), row("b", 1, 0)], [])
		expect(statements.map((statement) => statement.executionShare)).toEqual([0.75, 0.25])
		expect(statements[1]).toMatchObject({ p50LatencyMillis: null, p95LatencyMillis: null })
	})
})

describe("gcpQueryInsightsUnavailable", () => {
	it("says why from the settings: off, or not PostgreSQL", () => {
		expect(gcpQueryInsightsUnavailable(INSTANCE)).toBeNull()
		expect(gcpQueryInsightsUnavailable(undefined)).toBeNull()
		expect(gcpQueryInsightsUnavailable({ ...INSTANCE, queryInsightsEnabled: false })).toMatch(
			/^Query Insights is off for this instance\./,
		)
		expect(gcpQueryInsightsUnavailable({ ...INSTANCE, databaseVersion: "MYSQL_8_0" })).toBe(
			"Maple reads Query Insights for PostgreSQL instances only. orders-db runs MySQL 8.0.",
		)
	})
})
