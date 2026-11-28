// Trace facets and duration stats over a window older than `trace_facets_hourly` keeps (chDB).
// The rollup drops hours after 30 days while `trace_list_mv` keeps a trace for its own period, so
// hours past the rollup's retention must come from the raw rows or they silently count as zero.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as CH from "@maple/query-engine/ch"
import { Array as Arr, Schema, String as Str } from "effect"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import { describeWithChdb } from "./libchdb-test-support"

const DAY_MS = 86_400_000
const ORG = "org_facets_retention"
const iso = (ms: number) => Str.slice(0, 19)(Str.replace("T", " ")(new Date(ms).toISOString()))
const asJsonEachRow = (sql: string) => Str.replace(/\s+FORMAT\s+\w+\s*$/, "")(sql) + "\nFORMAT JSONEachRow"

const decodeFacets = decodeJsonEachRow(
	Schema.Struct({ name: Schema.String, count: CH.CHNumber, facetType: Schema.String }),
)
const decodeStats = decodeJsonEachRow(
	Schema.Struct({ minDurationMs: CH.CHNumber, maxDurationMs: CH.CHNumber }),
)

describeWithChdb("trace facets past the rollup's retention", () => {
	let root = ""
	let db: Chdb
	const nowMs = Date.now()
	// One root span 45 days back (kept by a 90-day period) and one a day back.
	const oldMs = nowMs - 45 * DAY_MS
	const recentMs = nowMs - DAY_MS
	const params = { orgId: ORG, startTime: iso(nowMs - 60 * DAY_MS), endTime: iso(nowMs) }

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-facets-retention-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		// The local raw table still has a fixed TTL; widen it so it holds the 90-day row.
		db.exec("ALTER TABLE trace_list_mv MODIFY TTL toDate(Timestamp) + toIntervalDay(RetentionDays)")
		const row = (ms: number, traceId: string, durationNs: number) =>
			`('${ORG}', '${traceId}', '${iso(ms)}', 'api', 'GET /users', 'Server', ${durationNs}, 'Ok', 'GET', '/users', '200', 'production', 0, '', '', 90)`
		db.exec(
			`INSERT INTO trace_list_mv (OrgId, TraceId, Timestamp, ServiceName, SpanName, SpanKind, Duration, StatusCode, HttpMethod, HttpRoute, HttpStatusCode, DeploymentEnv, HasError, TraceState, ServiceNamespace, RetentionDays) VALUES ${Arr.join(
				[row(oldMs, "t-old", 900_000_000), row(recentMs, "t-recent", 100_000_000)],
				", ",
			)}`,
		)
		// What the rollup's 30-day TTL leaves: the old hour is gone from it.
		db.exec(
			`ALTER TABLE trace_facets_hourly DELETE WHERE Hour < now() - INTERVAL 30 DAY SETTINGS mutations_sync = 1`,
		)
	})

	afterAll(() => {
		db?.close()
		if (root) rmSync(root, { recursive: true, force: true })
	})

	test("facets count hours the rollup has dropped from the raw rows", () => {
		const sql = CH.compileUnionUnsafe(CH.tracesFacetsQuery({ facet: "service" }), params).sql
		const rows = decodeFacets(db.query(asJsonEachRow(sql)))
		expect(Arr.map(rows, (r) => [r.name, Number(r.count)])).toEqual([["api", 2]])
	})

	test("duration stats see the dropped hour's spans", () => {
		const sql = CH.compileUnsafe(CH.tracesDurationStatsQuery({}), params).sql
		const [stats] = decodeStats(db.query(asJsonEachRow(sql)))
		expect(Number(stats?.minDurationMs)).toBe(100)
		expect(Number(stats?.maxDurationMs)).toBe(900)
	})
})

const decodePeriods = decodeJsonEachRow(Schema.Struct({ days: CH.CHNumber, traces: CH.CHNumber }))

// The rollup keeps one row per period, so a short-period source's counts expire with its spans.
describeWithChdb("trace facets keep each source's period", () => {
	let root = ""
	let db: Chdb
	const nowMs = Date.now()
	const hourMs = Math.floor((nowMs - 2 * DAY_MS) / 3_600_000) * 3_600_000
	const params = { orgId: ORG, startTime: iso(nowMs - 7 * DAY_MS), endTime: iso(nowMs) }
	const insertRoots = (rows: ReadonlyArray<readonly [ms: number, traceId: string, days: number]>) =>
		db.exec(
			`INSERT INTO trace_list_mv (OrgId, TraceId, Timestamp, ServiceName, SpanName, SpanKind, Duration, StatusCode, HttpMethod, HttpRoute, HttpStatusCode, DeploymentEnv, HasError, TraceState, ServiceNamespace, RetentionDays) VALUES ${Arr.join(
				Arr.map(
					rows,
					([ms, traceId, days]) =>
						`('${ORG}', '${traceId}', '${iso(ms)}', 'api', 'GET /users', 'Server', 1000000, 'Ok', 'GET', '/users', '200', 'production', 0, '', '', ${days})`,
				),
				", ",
			)}`,
		)
	const periods = () =>
		decodePeriods(
			db.query(
				`SELECT RetentionDays AS days, sum(TraceCount) AS traces FROM trace_facets_hourly WHERE OrgId = '${ORG}' GROUP BY days ORDER BY days FORMAT JSONEachRow`,
			),
		)

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-facets-periods-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		// Same hour, two periods; and a 3-day span five days back, past its period.
		insertRoots([
			[hourMs + 60_000, "t-short", 7],
			[hourMs + 120_000, "t-long", 30],
		])
		insertRoots([[nowMs - 5 * DAY_MS, "t-expired", 3]])
		db.exec("OPTIMIZE TABLE trace_facets_hourly FINAL")
		db.exec("ALTER TABLE trace_facets_hourly MATERIALIZE TTL SETTINGS mutations_sync = 1")
	})

	afterAll(() => {
		db?.close()
		if (root) rmSync(root, { recursive: true, force: true })
	})

	test("a merge keeps one row per period, and an expired period's counts are gone", () => {
		expect(Arr.map(periods(), (row) => [Number(row.days), Number(row.traces)])).toEqual([
			[7, 1],
			[30, 1],
		])
	})

	test("facets sum the period rows of an hour", () => {
		const sql = CH.compileUnionUnsafe(CH.tracesFacetsQuery({ facet: "service" }), params).sql
		const rows = decodeFacets(db.query(asJsonEachRow(sql)))
		// t-expired still sits in the local trace_list_mv, whose TTL is fixed at 30 days, but its
		// whole hour reads the rollup, which no longer counts it.
		expect(Arr.map(rows, (r) => [r.name, Number(r.count)])).toEqual([["api", 2]])
	})
})
