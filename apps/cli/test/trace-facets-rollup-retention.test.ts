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
