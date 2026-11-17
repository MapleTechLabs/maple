// profile_hotspots' read on a real ClickHouse engine: the stacks query folded into per-function
// totals, the way the MCP tool reads them, scoped to a trace and counting recursion once.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as CH from "@maple/query-engine/ch"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { topFunctions } from "@maple/domain/profiles"
import { Schema, Array as Arr, String as Str } from "effect"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import { describeWithChdb } from "./libchdb-test-support"

const ORG = "org_profile_hotspots"
const TRACE = "7f3a4b5c6d7e8f901234567890abcdef"
/** An hour ago on the minute: recent, so the table's TTL keeps it. */
const AT_MS = Math.floor(Date.now() / 60_000) * 60_000 - 3_600_000

const seconds = (ms: number) => Str.slice(0, 19)(Str.replace("T", " ")(new Date(ms).toISOString()))

interface Row {
	readonly profileId: string
	readonly sampleType?: string
	readonly traceId?: string
	readonly frames: ReadonlyArray<string>
	readonly value: number
}

const list = (items: ReadonlyArray<string>) =>
	`[${Arr.join(
		Arr.map(items, (item) => `'${item}'`),
		", ",
	)}]`

const insert = (db: Chdb, rows: ReadonlyArray<Row>) => {
	const values = Arr.map(
		rows,
		(row) =>
			`('${ORG}', '${seconds(AT_MS)}', 'scraper', '${row.profileId}', '${row.sampleType ?? "cpu"}', 'nanoseconds', ${row.value}, 1, 60000000000, ${list(row.frames)}, ${list(Arr.map(row.frames, (frame) => `src/${frame}.ts`))}, [${Arr.join(
				Arr.map(row.frames, () => "1"),
				", ",
			)}], '${row.traceId ?? ""}')`,
	)
	db.exec(
		`INSERT INTO profiles (OrgId, Timestamp, ServiceName, ProfileId, SampleType, SampleUnit, Value, Samples, DurationNano, Frames, FrameFiles, FrameLines, TraceId) VALUES ${Arr.join(values, ", ")}`,
	)
}

const StackRow = Schema.Struct({
	frames: Schema.Array(Schema.String),
	files: Schema.Array(Schema.String),
	lines: Schema.Array(CH.CHNumber),
	value: CH.CHNumber,
	totalValue: CH.CHNumber,
	totalStacks: CH.CHNumber,
})

describeWithChdb("profile hotspots", () => {
	let root = ""
	let db: Chdb

	const hotspots = (scope: { readonly traceId?: string }) => {
		const { sql } = compileUnsafe(
			CH.profileStacksQuery({ service: true, unit: true, trace: scope.traceId !== undefined }),
			{
				orgId: ORG,
				serviceName: "scraper",
				sampleType: "cpu",
				sampleUnit: "nanoseconds",
				startTime: seconds(AT_MS - 60_000),
				endTime: seconds(AT_MS + 60_000),
				...(scope.traceId === undefined ? undefined : { traceId: scope.traceId }),
			},
		)
		const rows = decodeJsonEachRow(StackRow)(db.query(normalizeSqlForClickHouseClient(sql)))
		const functions = topFunctions({ stacks: rows, totalValue: rows[0]?.totalValue ?? 0 }, 10)
		return {
			totalValue: rows[0]?.totalValue ?? 0,
			functions: Arr.map(functions, (fn) => [fn.name, fn.self, fn.total] as const),
		}
	}

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-profile-hotspots-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		insert(db, [
			// One stack in two profiles: the query sums it into one row.
			{ profileId: "a", frames: ["main", "scrape", "parse"], value: 400 },
			{ profileId: "b", frames: ["main", "scrape", "parse"], value: 200, traceId: TRACE },
			// Recursion: `walk` is on the stack twice, its total counts the stack once.
			{ profileId: "a", frames: ["main", "walk", "walk"], value: 300, traceId: TRACE },
			{ profileId: "b", frames: ["main", "gc"], value: 100 },
			// Another sample type is never mixed into cpu.
			{ profileId: "a", sampleType: "wall", frames: ["main", "sleep"], value: 9000 },
		])
	})

	afterAll(() => {
		db.close()
		rmSync(root, { recursive: true, force: true })
	})

	test("folds a service's stacks into functions by self time", () => {
		expect(hotspots({})).toEqual({
			totalValue: 1000,
			functions: [
				["parse", 600, 600],
				["walk", 300, 300],
				["gc", 100, 100],
				["main", 0, 1000],
				["scrape", 0, 600],
			],
		})
	})

	test("reads only the samples linked to the trace", () => {
		expect(hotspots({ traceId: TRACE })).toEqual({
			totalValue: 500,
			functions: [
				["walk", 300, 300],
				["parse", 200, 200],
				["main", 0, 500],
				["scrape", 0, 200],
			],
		})
	})
})
