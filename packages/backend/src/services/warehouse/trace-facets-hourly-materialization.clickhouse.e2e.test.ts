// SAFETY-FILE: JSON in this test is emitted by ClickHouse before its fields are asserted.
// `trace_facets_hourly` is cascaded off `trace_list_mv`: it fires on the insert
// blocks another view writes, not on `traces`, and a rollup nobody fills reads
// as "no data" rather than as an error. So this proves rows: spans inserted
// into `traces` on a database built from the real migration chain must roll up
// to exactly what `trace_list_mv` holds, and migration 0034's backfill must
// rebuild the same rollup from `trace_list_mv` alone.

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
const BASE_MS = Math.floor((Date.now() - 4 * HOUR_MS) / HOUR_MS) * HOUR_MS

const chDateTime = (epochMs: number): string => new Date(epochMs).toISOString().replace("T", " ").slice(0, 19)

interface SeedSpan {
	readonly traceId: string
	readonly ms: number
	readonly service: string
	readonly durationNs: number
	readonly parentSpanId?: string
	readonly status?: string
	readonly env?: string
}

const root = (traceId: string, ms: number, service: string, durationNs: number, extra = {}): SeedSpan => ({
	traceId,
	ms,
	service,
	durationNs,
	env: "production",
	...extra,
})

// Two insert blocks share the (hour, api, production) group, so the rollup holds
// two partial rows for it until a merge and reads must sum them.
const BATCH_1: ReadonlyArray<SeedSpan> = [
	root("t1", BASE_MS + 60_000, "api", 5_000_000),
	root("t2", BASE_MS + 120_000, "api", 9_000_000),
	root("t3", BASE_MS + 180_000, "worker", 1_000_000, { status: "Error", env: "staging" }),
	root("t4", BASE_MS + HOUR_MS + 60_000, "api", 2_000_000),
	// Not a root span: never reaches trace_list_mv, so never the rollup.
	{ traceId: "t1", ms: BASE_MS + 61_000, service: "api", durationNs: 1_000, parentSpanId: "root-t1" },
]
const BATCH_2: ReadonlyArray<SeedSpan> = [
	root("t5", BASE_MS + 240_000, "api", 3_000_000),
	// The longest span sits in a whole hour, so only the hourly tier can report it.
	root("t6", BASE_MS + HOUR_MS + 120_000, "api", 80_000_000),
	root("t7", BASE_MS + 2 * HOUR_MS + 300_000, "api", 4_000_000),
	root("t8", BASE_MS + 2 * HOUR_MS + 900_000, "api", 6_000_000),
	// The only failing staging root inside a whole hour: proves filters reach the hourly tier.
	root("t9", BASE_MS + HOUR_MS + 180_000, "worker", 30_000_000, { status: "Error", env: "staging" }),
]

const insert = async (spans: ReadonlyArray<SeedSpan>): Promise<void> => {
	const rows = spans
		.map(
			(span, index) =>
				`('${ORG_ID}', '${chDateTime(span.ms)}', '${span.traceId}', 'span-${span.traceId}-${index}', '${span.parentSpanId ?? ""}', 'op', 'Server', '${span.service}', ${span.durationNs}, '${span.status ?? "Ok"}', '', 1, map(), map('deployment.environment.name', '${span.env ?? ""}'))`,
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
	const body = await clickhouseExec(`${sql} FORMAT JSON`, database, {
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
		 FROM trace_list_mv WHERE OrgId = '${ORG_ID}'
		 GROUP BY ${DIMENSIONS} ORDER BY ${DIMENSIONS}`,
	)

const fromRollup = () =>
	runJson(
		`SELECT toString(Hour) AS Hour, ServiceName, SpanName, HttpMethod, HttpStatusCode,
		        DeploymentEnv, ServiceNamespace, HasError,
		        sum(TraceCount) AS traces, min(DurationMin) AS durationMin, max(DurationMax) AS durationMax
		 FROM trace_facets_hourly WHERE OrgId = '${ORG_ID}'
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

	it("rolls up every root span of trace_list_mv, live and from migration 0034's backfill", async () => {
		const expected = await fromTraceList()
		assert.strictEqual(
			expected.reduce((total, row) => total + Number(row.traces), 0),
			9,
		)
		assert.deepStrictEqual(await fromRollup(), expected)

		const backfill = migrations
			.find((migration) => migration.version === 34)!
			.statements.find((statement) => typeof statement !== "string")!
		await clickhouseExec("TRUNCATE TABLE trace_facets_hourly", database)
		await clickhouseExec(renderStatementFull(backfill, database), database)
		assert.deepStrictEqual(await fromRollup(), expected)
	})

	// Starts mid-hour after t1 and ends mid-hour between t7 and t8, so both raw
	// edges hold rows in and out of the window; the aligned window has an empty
	// raw tier, whose zero extremes must not reach the result.
	it("answers the sidebar identically from the splice and from trace_list_mv alone", async () => {
		const run = (sql: string) => runJson(normalizeSqlForClickHouseClient(sql))
		const byFacet = (rows: ReadonlyArray<Record<string, unknown>>) =>
			[...rows].sort((a, b) => `${a.facetType}:${a.name}`.localeCompare(`${b.facetType}:${b.name}`))

		for (const [filters, longestMs] of [
			[{}, 80],
			[{ hasError: true, deploymentEnvs: ["staging"] }, 30],
		] as const) {
			for (const [startMs, endMs] of [
				[BASE_MS + 90_000, BASE_MS + 2 * HOUR_MS + 600_000],
				[BASE_MS + HOUR_MS, BASE_MS + 2 * HOUR_MS],
			] as const) {
				const window = { orgId: ORG_ID, startTime: chDateTime(startMs), endTime: chDateTime(endMs) }
				const facets = (rawOnly: boolean) =>
					CH.compileUnionUnsafe(CH.tracesFacetsQuery({ ...filters, rawOnly }), window).sql
				const stats = (rawOnly: boolean) =>
					CH.compileUnsafe(CH.tracesDurationStatsQuery({ ...filters, rawOnly }), window).sql
				assert.include(facets(false), "trace_facets_hourly")
				assert.notInclude(facets(true), "trace_facets_hourly")
				assert.notInclude(stats(true), "trace_facets_hourly")

				assert.deepStrictEqual(byFacet(await run(facets(false))), byFacet(await run(facets(true))))
				const [spliced] = await run(stats(false))
				const [raw] = await run(stats(true))
				assert.strictEqual(spliced!.minDurationMs, raw!.minDurationMs)
				assert.strictEqual(spliced!.maxDurationMs, longestMs)
				assert.strictEqual(raw!.maxDurationMs, longestMs)
				for (const key of ["p50DurationMs", "p95DurationMs"]) {
					assert.closeTo(Number(spliced![key]), Number(raw![key]), Number(raw![key]) * 0.01)
				}
			}
		}
	})
})
