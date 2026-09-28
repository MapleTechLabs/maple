// SAFETY-FILE: JSON in this test is emitted by ClickHouse before its fields are asserted.
// `trace_facets_hourly` is cascaded off `trace_list_mv`: it fires on the insert
// blocks another view writes, not on `traces`. That only works if ClickHouse
// actually chains the two views, and a rollup nobody fills reads as "no data"
// rather than as an error. So this suite proves rows: it inserts spans into
// `traces` on a database built from the real migration chain and asserts the
// rollup agrees with `trace_list_mv` group for group, then that migration 0034's
// backfill reproduces the same rollup from `trace_list_mv` alone.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { migrations, renderStatementFull } from "@maple/domain/clickhouse"
import * as CH from "@maple/query-engine/ch"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_trace_facets_e2e")
const ORG_ID = "org_trace_facets_e2e"

// Anchored to now: `traces` carries a 30-day TTL enforced at insert.
const HOUR_MS = 3_600_000
const BASE_MS = Math.floor((Date.now() - 3 * HOUR_MS) / HOUR_MS) * HOUR_MS

const chDateTime = (epochMs: number): string => new Date(epochMs).toISOString().replace("T", " ").slice(0, 23)
const quote = (value: string): string => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
const chMap = (attrs: Readonly<Record<string, string>>): string =>
	`map(${Object.entries(attrs)
		.flatMap(([key, value]) => [quote(key), quote(value)])
		.join(", ")})`

interface SeedSpan {
	readonly traceId: string
	readonly parentSpanId?: string
	readonly name: string
	readonly ms: number
	readonly service: string
	readonly status?: string
	readonly durationNs: number
	readonly attrs?: Readonly<Record<string, string>>
	readonly resource?: Readonly<Record<string, string>>
}

const PROD = { "deployment.environment.name": "production", "service.namespace": "core" }

const BATCH_1: ReadonlyArray<SeedSpan> = [
	// Old and new HTTP semconv for the same request: one group after coalescing.
	{
		traceId: "t1",
		name: "http.server GET",
		ms: BASE_MS + 60_000,
		service: "api",
		durationNs: 5_000_000,
		attrs: { "http.method": "GET", "http.route": "/users", "http.status_code": "200" },
		resource: PROD,
	},
	{
		traceId: "t2",
		name: "http.server GET",
		ms: BASE_MS + 120_000,
		service: "api",
		durationNs: 9_000_000,
		attrs: { "http.request.method": "GET", "http.route": "/users", "http.response.status_code": "200" },
		resource: PROD,
	},
	// A 5xx: HasError without an Error status.
	{
		traceId: "t3",
		name: "POST",
		ms: BASE_MS + 180_000,
		service: "api",
		durationNs: 50_000_000,
		attrs: { "http.request.method": "POST", "url.path": "/orders", "http.response.status_code": "503" },
		resource: PROD,
	},
	{
		traceId: "t4",
		name: "cron.tick",
		ms: BASE_MS + HOUR_MS + 60_000,
		service: "worker",
		status: "Error",
		durationNs: 1_000_000,
		resource: { "deployment.environment": "staging" },
	},
	// Not a root span: never reaches trace_list_mv, so never the rollup.
	{
		traceId: "t1",
		parentSpanId: "root-t1",
		name: "db.query",
		ms: BASE_MS + 61_000,
		service: "api",
		durationNs: 2_000_000,
	},
]

// A second insert block into an hour the first one already wrote: the rollup
// holds two partial rows for that group until a merge, and reads must sum them.
const BATCH_2: ReadonlyArray<SeedSpan> = [
	{
		traceId: "t6",
		name: "http.server GET",
		ms: BASE_MS + HOUR_MS + 120_000,
		service: "api",
		durationNs: 7_000_000,
		attrs: { "http.method": "GET", "http.route": "/users", "http.status_code": "200" },
		resource: PROD,
	},
	{
		traceId: "t5",
		name: "http.server GET",
		ms: BASE_MS + 240_000,
		service: "api",
		durationNs: 1_000_000,
		attrs: { "http.method": "GET", "http.route": "/users", "http.status_code": "200" },
		resource: PROD,
	},
]

const traceFacetsHourlyBackfill = migrations
	.find((migration) => migration.version === 34)!
	.statements.find((statement) => typeof statement !== "string")!

const ROOT_SPAN_COUNT = [...BATCH_1, ...BATCH_2].filter((span) => !span.parentSpanId).length

const insert = async (spans: ReadonlyArray<SeedSpan>): Promise<void> => {
	const rows = spans
		.map(
			(span, index) =>
				`(${quote(ORG_ID)}, ${quote(chDateTime(span.ms))}, ${quote(span.traceId)}, ${quote(`span-${span.traceId}-${index}`)}, ${quote(span.parentSpanId ?? "")}, ${quote(span.name)}, 'Server', ${quote(span.service)}, ${span.durationNs}, ${quote(span.status ?? "Ok")}, '', 1, ${chMap(span.attrs ?? {})}, ${chMap(span.resource ?? {})})`,
		)
		.join("\n,")
	await clickhouseExec(
		`INSERT INTO traces
		 (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, StatusMessage, SampleRate, SpanAttributes, ResourceAttributes)
		 VALUES\n${rows}`,
		database,
	)
}

const runJson = async (sql: string): Promise<ReadonlyArray<Record<string, unknown>>> => {
	const body = await clickhouseExec(sql.includes("FORMAT JSON") ? sql : `${sql} FORMAT JSON`, database, {
		output_format_json_quote_64bit_integers: "0",
	})
	return (JSON.parse(body) as { readonly data?: ReadonlyArray<Record<string, unknown>> }).data ?? []
}

const DIMENSIONS =
	"Hour, ServiceName, SpanName, HttpMethod, HttpStatusCode, DeploymentEnv, ServiceNamespace, HasError"

const fromTraceList = () =>
	runJson(
		`SELECT toString(toStartOfHour(Timestamp)) AS Hour, ServiceName, SpanName, HttpMethod, HttpStatusCode,
		        DeploymentEnv, ServiceNamespace, HasError,
		        count() AS traces, min(Duration) AS durationMin, max(Duration) AS durationMax
		 FROM trace_list_mv WHERE OrgId = ${quote(ORG_ID)}
		 GROUP BY ${DIMENSIONS} ORDER BY ${DIMENSIONS}`,
	)

const fromRollup = () =>
	runJson(
		`SELECT toString(Hour) AS Hour, ServiceName, SpanName, HttpMethod, HttpStatusCode,
		        DeploymentEnv, ServiceNamespace, HasError,
		        sum(TraceCount) AS traces, min(DurationMin) AS durationMin, max(DurationMax) AS durationMax
		 FROM trace_facets_hourly WHERE OrgId = ${quote(ORG_ID)}
		 GROUP BY ${DIMENSIONS} ORDER BY ${DIMENSIONS}`,
	)

describe.skipIf(!clickhouseE2eEnabled)("trace_facets_hourly materialization", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await insert(BATCH_1)
		await insert(BATCH_2)
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

	it("rolls up every root span trace_list_mv holds, group for group", async () => {
		const expected = await fromTraceList()
		const actual = await fromRollup()

		assert.deepStrictEqual(actual, expected)
		assert.strictEqual(
			actual.reduce((total, row) => total + Number(row.traces), 0),
			ROOT_SPAN_COUNT,
		)
		// The coalesced semconv spellings and the rewritten span name landed in one group.
		assert.deepInclude(actual, {
			Hour: chDateTime(BASE_MS).slice(0, 19),
			ServiceName: "api",
			SpanName: "GET /users",
			HttpMethod: "GET",
			HttpStatusCode: "200",
			DeploymentEnv: "production",
			ServiceNamespace: "core",
			HasError: 0,
			traces: 3,
			durationMin: 1_000_000,
			durationMax: 9_000_000,
		})
	})

	// Starts mid-hour, after t1: the first hour is a raw edge that must drop t1,
	// the second a whole hour the rollup answers, and the end a partial hour.
	it("answers the sidebar facets and duration stats identically from the splice and from trace_list_mv", async () => {
		const window = {
			orgId: ORG_ID,
			startTime: chDateTime(BASE_MS + 90_000).slice(0, 19),
			endTime: chDateTime(BASE_MS + 2 * HOUR_MS + 600_000).slice(0, 19),
		}
		const run = async (sql: string) => runJson(normalizeSqlForClickHouseClient(sql))
		const byFacet = (rows: ReadonlyArray<Record<string, unknown>>) =>
			[...rows].sort((a, b) => `${a.facetType}:${a.name}`.localeCompare(`${b.facetType}:${b.name}`))

		// `minDurationMs: 0` filters nothing and forces the trace_list_mv-only route.
		const spliced = CH.compileUnionUnsafe(CH.tracesFacetsQuery({}), window).sql
		const raw = CH.compileUnionUnsafe(CH.tracesFacetsQuery({ minDurationMs: 0 }), window).sql
		assert.include(spliced, "trace_facets_hourly")
		assert.notInclude(raw, "trace_facets_hourly")

		const splicedRows = byFacet(await run(spliced))
		assert.deepStrictEqual(splicedRows, byFacet(await run(raw)))
		assert.deepInclude(splicedRows, { name: "GET /users", count: 3, facetType: "spanName" })

		const [splicedStats] = await run(CH.compileUnsafe(CH.tracesDurationStatsQuery({}), window).sql)
		const [rawStats] = await run(
			CH.compileUnsafe(CH.tracesDurationStatsQuery({ minDurationMs: 0 }), window).sql,
		)
		assert.strictEqual(splicedStats!.minDurationMs, rawStats!.minDurationMs)
		assert.strictEqual(splicedStats!.maxDurationMs, rawStats!.maxDurationMs)
		assert.isAbove(Number(splicedStats!.p50DurationMs), 0)
	})

	it("reproduces the same rollup from migration 0034's backfill", async () => {
		const expected = await fromRollup()
		await clickhouseExec("TRUNCATE TABLE trace_facets_hourly", database)
		await clickhouseExec(renderStatementFull(traceFacetsHourlyBackfill, database), database)

		assert.deepStrictEqual(await fromRollup(), expected)
	})
})
