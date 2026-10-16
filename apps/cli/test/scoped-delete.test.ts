import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import schemaSql from "../src/server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "../src/server/chdb"
import { decodeJsonEachRow } from "../src/server/chdb-rows"
import { buildLocalSchemaManifest } from "../src/server/schema-manifest"
import { LOCAL_SCHEMA_MANIFEST } from "../src/server/schema-identity"
import { serviceMapRollupInserts } from "../src/server/service-map-rollup"
import {
	pendingDeletePath,
	resumePendingDelete,
	runScopedDelete,
	TABLE_DELETE_PLAN,
	tablePlan,
	validateDeletePlan,
} from "../src/server/scoped-delete"

describe("scoped delete plan", () => {
	// Fails when a table is added to the local schema without a delete strategy.
	test("classifies every table in the bundled schema soundly", () => {
		expect(validateDeletePlan(LOCAL_SCHEMA_MANIFEST)).toEqual([])
		const tables = LOCAL_SCHEMA_MANIFEST.objects.filter((o) => o.kind === "table").map((o) => o.name)
		expect(Object.keys(TABLE_DELETE_PLAN).sort()).toEqual([...tables].sort())
	})

	const withExtra = (ddl: string) => buildLocalSchemaManifest(`${schemaSql}\n\n${ddl}\n`)

	test("refuses a new derived table nobody classified", () => {
		const manifest = withExtra(
			"CREATE TABLE IF NOT EXISTS traces_by_route (OrgId String, Hour DateTime, ServiceName String, Count UInt64)\nENGINE = SummingMergeTree\nORDER BY (OrgId, Hour);\n\nCREATE MATERIALIZED VIEW IF NOT EXISTS traces_by_route_mv TO traces_by_route AS\nSELECT OrgId, toStartOfHour(toDateTime(Timestamp)) AS Hour, ServiceName, count() AS Count FROM traces GROUP BY OrgId, Hour, ServiceName;",
		)
		expect(validateDeletePlan(manifest)).toContain("traces_by_route: no delete plan for this table")
	})

	test("refuses a filter on a merged column that is not a key", () => {
		const problems = validateDeletePlan(LOCAL_SCHEMA_MANIFEST, {
			...TABLE_DELETE_PLAN,
			error_fingerprints_minutely: {
				strategy: "scoped",
				time: "Minute",
				service: ["ServiceName"],
				namespace: null,
				env: null,
				recompute: "views",
			},
		})
		expect(problems.some((p) => p.includes("ServiceName is not in the sorting key"))).toBe(true)
	})

	test("refuses a table that can neither filter nor recompute a namespace", () => {
		const problems = validateDeletePlan(LOCAL_SCHEMA_MANIFEST, {
			...TABLE_DELETE_PLAN,
			service_map_spans: {
				strategy: "scoped",
				time: "Timestamp",
				service: ["ServiceName"],
				namespace: null,
				env: { column: "DeploymentEnv" },
				recompute: null,
			},
		})
		expect(problems).toContain("service_map_spans: cannot delete --namespace and has no recompute")
	})

	test("refuses recomputing a view source whose dependant is filtered", () => {
		const problems = validateDeletePlan(LOCAL_SCHEMA_MANIFEST, {
			...TABLE_DELETE_PLAN,
			service_operations_hourly: {
				strategy: "scoped",
				time: "Hour",
				service: ["ServiceName"],
				namespace: { resourceAttributes: "ResourceAttributes" },
				env: { column: "DeploymentEnv" },
				recompute: "views",
			},
		})
		expect(problems.some((p) => p.includes("leaks into service_operations_hourly"))).toBe(true)
	})

	test("refuses excluding a table that telemetry views write", () => {
		const problems = validateDeletePlan(LOCAL_SCHEMA_MANIFEST, {
			...TABLE_DELETE_PLAN,
			trace_list_mv: { strategy: "excluded", reason: "test" },
		})
		expect(problems).toContain("trace_list_mv_mv: writes excluded trace_list_mv from traces")
	})
})

// Needs a real libchdb; skipped where none is installed.
const libchdbAvailable =
	(process.env.MAPLE_LIBCHDB !== undefined && existsSync(process.env.MAPLE_LIBCHDB)) ||
	existsSync(join(homedir(), ".maple", "bin", "libchdb.so")) ||
	existsSync(join(homedir(), ".maple", "bin", "libchdb.dylib"))

const HOUR_MS = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "")
const decodeCount = decodeJsonEachRow(Schema.Struct({ n: Schema.String }))

describe.skipIf(!libchdbAvailable)("scoped delete against chDB", () => {
	let root = ""
	let dataDir = ""
	let db: Chdb
	const now = Date.now()
	const hourAgo = Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS + 60_000
	const twoHoursAgo = hourAgo - HOUR_MS

	const count = (sql: string) => Number(decodeCount(db.query(sql))[0]?.n)
	const serviceRows = (table: string, service: string) => {
		const plan = tablePlan(table)!
		const columns = plan.strategy === "scoped" && plan.service !== null ? plan.service : ["ServiceName"]
		return count(
			`SELECT toString(count()) AS n FROM ${table} WHERE ${columns.map((c) => `${c} = '${service}'`).join(" OR ")}`,
		)
	}
	const attributeKey = (key: string) =>
		count(`SELECT toString(sum(UsageCount)) AS n FROM attribute_keys_hourly WHERE AttributeKey = '${key}'`)

	const span = (at: number, id: string, service: string, env: string, parent = "", kind = "Server") =>
		`('local', '${iso(at)}', 't-${id}', 's-${id}', '${parent}', 'GET /x', '${kind}', '${service}', 1000000, 'Error', ` +
		`map('deployment.environment', '${env}'), map('attr.${service}', 'v', 'shared.key', 'v', 'exception.type', 'E'), ` +
		`[toDateTime64('${iso(at)}', 9)], ['exception'], [map('exception.type', 'Boom', 'exception.message', 'm')])`
	const log = (at: number, service: string, env: string) =>
		`('local', '${iso(at)}', '${iso(at).slice(0, 19)}', '${service}', 'body', map('deployment.environment', '${env}'), map('log.${service}', 'v'))`
	const metric = (at: number, service: string, env: string) =>
		`('local', map('deployment.environment', '${env}'), '${service}', 'm.${service}', map('k', 'v'), '${iso(at)}', '${iso(at)}', 1, 1)`

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-scoped-delete-"))
		dataDir = join(root, "data")
		db = Chdb.open({ dataDir, schemaSql })
		const spans = [
			span(twoHoursAgo, "k1", "keep", "prod"),
			span(hourAgo, "k2", "keep", "prod"),
			span(twoHoursAgo, "d1", "drop", "prod"),
			span(hourAgo, "d2", "drop", "pr-1"),
			span(hourAgo + 1, "d3", "drop", "prod", "", "Client"),
		]
		db.exec(
			`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, ResourceAttributes, SpanAttributes, EventsTimestamp, EventsName, EventsAttributes) VALUES ${spans.join(", ")}`,
		)
		db.exec(
			`INSERT INTO logs (OrgId, Timestamp, TimestampTime, ServiceName, Body, ResourceAttributes, LogAttributes) VALUES ${[
				log(twoHoursAgo, "keep", "prod"),
				log(hourAgo, "drop", "prod"),
				log(hourAgo, "drop", "pr-1"),
			].join(", ")}`,
		)
		db.exec(
			`INSERT INTO metrics_sum (OrgId, ResourceAttributes, ServiceName, MetricName, Attributes, StartTimeUnix, TimeUnix, Value, IsMonotonic) VALUES ${[
				metric(hourAgo, "keep", "prod"),
				metric(hourAgo, "drop", "prod"),
				metric(hourAgo, "drop", "pr-1"),
			].join(", ")}`,
		)
		db.exec(
			`INSERT INTO service_map_edges_hourly_ingest (OrgId, Hour, SourceService, TargetService, DeploymentEnv, CallCount) VALUES ('local', toStartOfHour(toDateTime('${iso(hourAgo).slice(0, 19)}')), 'keep', 'drop', 'prod', 3), ('local', toStartOfHour(toDateTime('${iso(hourAgo).slice(0, 19)}')), 'keep', 'db', 'prod', 2)`,
		)
	}, 120_000)

	afterAll(() => {
		db?.close()
		if (root) rmSync(root, { recursive: true, force: true })
	})

	const deleteNow = (request: Parameters<typeof runScopedDelete>[3], dryRun = false) =>
		Effect.runPromise(runScopedDelete(db, LOCAL_SCHEMA_MANIFEST, dataDir, request, { dryRun }))

	test("seed reached the derived tables", () => {
		for (const table of ["trace_list_mv", "service_overview_hourly", "error_events", "service_usage", "metric_catalog"])
			expect(serviceRows(table, "drop")).toBeGreaterThan(0)
		expect(attributeKey("attr.drop")).toBe(3)
	})

	test("dry run counts without deleting", async () => {
		const report = await deleteNow({ service: "drop", env: "pr-1" }, true)
		expect(report.dryRun).toBe(true)
		expect(report.tables.find((t) => t.table === "traces")?.rows).toBe(1)
		expect(serviceRows("traces", "drop")).toBe(3)
		expect(existsSync(pendingDeletePath(dataDir))).toBe(false)
	})

	test("--env removes one environment and recomputes tables without one", async () => {
		const usageBefore = count(
			"SELECT toString(sum(TraceCount)) AS n FROM service_usage WHERE ServiceName = 'drop'",
		)
		expect(usageBefore).toBe(3)
		const report = await deleteNow({ service: "drop", env: "pr-1" })
		expect(report.tables.find((t) => t.table === "service_usage")?.strategy).toBe("rebuild")
		expect(count("SELECT toString(count()) AS n FROM traces WHERE ServiceName = 'drop'")).toBe(2)
		expect(count("SELECT toString(count()) AS n FROM trace_list_mv WHERE DeploymentEnv = 'pr-1'")).toBe(0)
		expect(
			count("SELECT toString(sum(TraceCount)) AS n FROM service_usage WHERE ServiceName = 'drop'"),
		).toBe(2)
		expect(count("SELECT toString(sum(LogCount)) AS n FROM service_usage WHERE ServiceName = 'drop'")).toBe(1)
		expect(attributeKey("attr.drop")).toBe(2)
		expect(existsSync(pendingDeletePath(dataDir))).toBe(false)
	})

	test("--service removes every derived row and keeps other services intact", async () => {
		const keepBefore = Object.fromEntries(
			Object.entries(TABLE_DELETE_PLAN)
				.filter(([, plan]) => plan.strategy === "scoped" && plan.service !== null)
				.map(([table]) => [table, serviceRows(table, "keep")]),
		)
		const sharedBefore = attributeKey("shared.key")
		await deleteNow({ service: "drop" })
		for (const [table, plan] of Object.entries(TABLE_DELETE_PLAN)) {
			if (plan.strategy !== "scoped" || plan.service === null) continue
			expect({ table, rows: serviceRows(table, "drop") }).toEqual({ table, rows: 0 })
			// Edges from keep to drop go too: they were derived from drop's spans.
			if (table !== "service_map_edges_hourly")
				expect({ table, rows: serviceRows(table, "keep") }).toEqual({ table, rows: keepBefore[table]! })
		}
		expect(serviceRows("service_map_edges_hourly", "keep")).toBe(1)
		expect(serviceRows("error_fingerprints_minutely", "drop")).toBe(0)
		expect(attributeKey("attr.drop")).toBe(0)
		expect(attributeKey("log.drop")).toBe(0)
		expect(attributeKey("attr.keep")).toBe(2)
		expect(attributeKey("shared.key")).toBe(sharedBefore - 2)
	})

	test("--before only removes hours before the floored cutoff", async () => {
		const report = await deleteNow({ service: "keep", beforeMs: hourAgo + 30 * 60_000 })
		expect(report.request.beforeMs).toBe(hourAgo - 60_000)
		expect(count("SELECT toString(count()) AS n FROM traces WHERE ServiceName = 'keep'")).toBe(1)
		expect(count("SELECT toString(count()) AS n FROM trace_list_mv WHERE ServiceName = 'keep'")).toBe(1)
		expect(attributeKey("attr.keep")).toBe(1)
	})

	test("a journaled delete resumes on the next run", async () => {
		db.exec(
			`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, ResourceAttributes, SpanAttributes, EventsTimestamp, EventsName, EventsAttributes) VALUES ${span(hourAgo, "z1", "zombie", "prod")}`,
		)
		writeFileSync(
			pendingDeletePath(dataDir),
			JSON.stringify({ formatVersion: 1, request: { service: "zombie" }, rebuildHours: {} }),
		)
		await Effect.runPromise(resumePendingDelete(db, LOCAL_SCHEMA_MANIFEST, dataDir))
		expect(serviceRows("trace_list_mv", "zombie")).toBe(0)
		expect(attributeKey("attr.zombie")).toBe(0)
		expect(existsSync(pendingDeletePath(dataDir))).toBe(false)
	})
})

describe.skipIf(!libchdbAvailable)("namespace delete against chDB", () => {
	let root = ""
	let dataDir = ""
	let db: Chdb
	const hourMs = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 2 * HOUR_MS
	const at = hourMs + 10 * 60_000

	const count = (sql: string) => Number(decodeCount(db.query(sql))[0]?.n)
	// A client span calling a child server span named "api", both in `namespace`.
	const call = (id: string, client: string, namespace: string) => {
		const resource = (service: string) =>
			`map('service.name', '${service}', 'service.namespace', '${namespace}', 'deployment.environment', 'prod')`
		return (
			`('local', '${iso(at)}', 't-${id}', 'c-${id}', '', 'GET /api', 'Client', '${client}', 5000000, 'Ok', ${resource(client)}, map('server.address', 'api.internal')), ` +
			`('local', '${iso(at + 1)}', 't-${id}', 's-${id}', 'c-${id}', 'GET /api', 'Server', 'api', 4000000, 'Error', ${resource("api")}, map('exception.type', 'E'))`
		)
	}
	const edge = (source: string) =>
		count(
			`SELECT toString(sum(CallCount)) AS n FROM service_map_edges_hourly WHERE SourceService = '${source}' AND TargetService = 'api'`,
		)

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "maple-scoped-delete-ns-"))
		dataDir = join(root, "data")
		db = Chdb.open({ dataDir, schemaSql })
		db.exec(
			`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, ResourceAttributes, SpanAttributes) VALUES ${call("a", "web", "pr-1")}, ${call("b", "caller", "pr-2")}`,
		)
		for (const statement of await Effect.runPromise(serviceMapRollupInserts(hourMs))) db.exec(statement)
	}, 120_000)

	afterAll(() => {
		db?.close()
		if (root) rmSync(root, { recursive: true, force: true })
	})

	test("removes one namespace and keeps a same-named service in another", async () => {
		expect(edge("web")).toBe(1)
		expect(edge("caller")).toBe(1)
		expect(count("SELECT toString(sum(SpanCount)) AS n FROM service_operations_hourly WHERE ServiceName = 'api'")).toBe(2)

		const report = await Effect.runPromise(
			runScopedDelete(db, LOCAL_SCHEMA_MANIFEST, dataDir, { namespace: "pr-1" }, { dryRun: false }),
		)
		const strategy = (table: string) => report.tables.find((t) => t.table === table)?.strategy
		expect(strategy("trace_list_mv")).toBe("filter")
		expect(strategy("error_events")).toBe("rebuild")
		expect(strategy("service_map_edges_hourly")).toBe("rebuild")

		expect(count("SELECT toString(count()) AS n FROM traces WHERE ResourceAttributes['service.namespace'] = 'pr-1'")).toBe(0)
		expect(count("SELECT toString(count()) AS n FROM traces WHERE ServiceName = 'api'")).toBe(1)
		expect(count("SELECT toString(count()) AS n FROM trace_list_mv WHERE ServiceNamespace = 'pr-1'")).toBe(0)
		for (const [table, plan] of Object.entries(TABLE_DELETE_PLAN)) {
			if (plan.strategy !== "scoped" || plan.service === null) continue
			const where = plan.service.map((c) => `${c} = 'web'`).join(" OR ")
			expect({ table, rows: count(`SELECT toString(count()) AS n FROM ${table} WHERE ${where}`) }).toEqual({
				table,
				rows: 0,
			})
		}
		// Recomputed from pr-2's surviving api span, including the cascaded hourly rollup.
		expect(count("SELECT toString(count()) AS n FROM error_events WHERE ServiceName = 'api'")).toBe(1)
		expect(count("SELECT toString(sum(OccurrenceCount)) AS n FROM error_fingerprints_minutely")).toBe(1)
		expect(count("SELECT toString(sum(SpanCount)) AS n FROM service_operations_minutely WHERE ServiceName = 'api'")).toBe(1)
		expect(count("SELECT toString(sum(SpanCount)) AS n FROM service_operations_hourly WHERE ServiceName = 'api'")).toBe(1)
		expect(count("SELECT toString(sum(TraceCount)) AS n FROM service_usage WHERE ServiceName = 'api'")).toBe(1)
		expect(edge("web")).toBe(0)
		expect(edge("caller")).toBe(1)
		expect(existsSync(pendingDeletePath(dataDir))).toBe(false)
	})
})
